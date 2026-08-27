//! OpenPets native Wayland backend helper (experimental).
//!
//! This process owns a `wlr-layer-shell` overlay surface (the "pet") and
//! renders whatever frames the Electron main process sends it over a Unix
//! domain socket. The Electron side keeps rendering the pet with the normal
//! HTML/CSS animation pipeline (in a hidden offscreen `BrowserWindow`), so the
//! pet runtime and animation renderer are unchanged — only the on-screen
//! carrier surface is a native layer-shell overlay instead of an XDG toplevel.
//!
//! Why a separate helper process? Electron/Chromium's Ozone does not implement
//! `wlr-layer-shell`, so a layer-shell surface cannot be created from inside
//! Electron. A small native helper is the clean boundary: it never shows a
//! normal application window, never takes keyboard focus, and does not appear
//! in `niri msg windows` / the compositor's toplevel list.

mod protocol;

use std::collections::VecDeque;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use protocol::{
    Message, PT_ENTER, PT_LEAVE, PT_MOVE, PT_PRESS, PT_RELEASE, TAG_POINTER, TAG_POSITION,
    TAG_READY,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_pointer, delegate_registry,
    delegate_seat, delegate_shm,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{slot::Buffer, slot::SlotPool, Shm, ShmHandler},
};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_seat, wl_shm, wl_surface},
    Connection, QueueHandle,
};

// ---------------------------------------------------------------------------
// Startup arguments
// ---------------------------------------------------------------------------

struct Args {
    /// Unix socket path the Electron client connects to.
    socket_path: String,
    /// Initial surface size (matches the pet window / renderer size).
    width: u32,
    height: u32,
    /// Initial top-left corner in global compositor (logical) coordinates.
    x: i32,
    y: i32,
}

fn parse_args() -> Args {
    let mut socket_path = None;
    let mut width = 340u32;
    let mut height = 420u32;
    let mut x = 0i32;
    let mut y = 0i32;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next(),
            "--width" => width = args.next().and_then(|v| v.parse().ok()).unwrap_or(width),
            "--height" => height = args.next().and_then(|v| v.parse().ok()).unwrap_or(height),
            "--x" => x = args.next().and_then(|v| v.parse().ok()).unwrap_or(x),
            "--y" => y = args.next().and_then(|v| v.parse().ok()).unwrap_or(y),
            "--help" | "-h" => {
                eprintln!(
                    "usage: openpets-wayland-helper --socket <path> [--width N] [--height N] [--x N] [--y N]"
                );
                std::process::exit(0);
            }
            _ => {}
        }
    }

    let socket_path = socket_path.unwrap_or_else(|| panic!("--socket <path> is required"));
    if width == 0 || height == 0 {
        panic!("invalid surface size {width}x{height}");
    }

    Args { socket_path, width, height, x, y }
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

enum SocketEvent {
    /// The single Electron client connected (carries the stream for replies).
    Connected(UnixStream),
    Message(Message),
    /// The client closed the connection; the helper should shut down.
    Disconnected,
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

struct App {
    registry_state: RegistryState,
    output_state: OutputState,
    seat_state: SeatState,
    shm: Shm,
    layer: LayerSurface,
    _pointer: Option<wl_pointer::WlPointer>,

    width: u32,
    height: u32,
    position: (i32, i32),
    visible: bool,
    configured: bool,

    /// Logical geometry of the primary output: (x, y, width, height).
    output_geometry: Option<(i32, i32, i32, i32)>,

    pool: SlotPool,
    /// Recently committed buffers kept alive until the compositor releases
    /// them (a small ring; slots are recycled via the pool's free list).
    live_buffers: VecDeque<Buffer>,

    /// The connected client stream, used for helper → client messages (e.g.
    /// READY once the surface is configured).
    client_writer: Option<UnixStream>,

    /// Latest frame received from the client. Kept so a frame that arrives
    /// before the first configure (or while hidden) can be presented as soon
    /// as the surface is ready.
    pending_frame: Option<protocol::Frame>,

    /// Pointer drag state. While a left-button drag is in progress the helper
    /// moves the surface directly (incrementally) instead of routing motion
    /// through the renderer, which avoids a feedback loop when the surface
    /// moves under the cursor.
    dragging: bool,
    /// Surface-local cursor position from the previous pointer motion frame.
    drag_prev_local: (f64, f64),
}

// ---------------------------------------------------------------------------
// Debug logging (opt-in via OPENPETS_WAYLAND_HELPER_DEBUG=1)
// ---------------------------------------------------------------------------

fn debug_log(msg: &str) {
    if std::env::var("OPENPETS_WAYLAND_HELPER_DEBUG").as_deref() == Ok("1") {
        eprintln!("openpets-wayland-helper: {msg}");
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    let args = parse_args();

    // Bind the socket before touching Wayland so a failure here is reported
    // before any surface state exists.
    let listener = match UnixListener::bind(&args.socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("openpets-wayland-helper: failed to bind socket {}: {e}", args.socket_path);
            std::process::exit(2);
        }
    };

    let conn = match Connection::connect_to_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "openpets-wayland-helper: cannot connect to Wayland (is a compositor running?): {e}"
            );
            std::process::exit(2);
        }
    };

    let (globals, mut event_queue) = registry_queue_init(&conn).expect("wayland globals init failed");
    let qh = event_queue.handle();

    let compositor = match CompositorState::bind(&globals, &qh) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("openpets-wayland-helper: wl_compositor unavailable: {e}");
            std::process::exit(2);
        }
    };
    let layer_shell = match LayerShell::bind(&globals, &qh) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "openpets-wayland-helper: wlr-layer-shell is not available on this compositor: {e}"
            );
            std::process::exit(2);
        }
    };
    let shm = match Shm::bind(&globals, &qh) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("openpets-wayland-helper: wl_shm unavailable: {e}");
            std::process::exit(2);
        }
    };

    let surface = compositor.create_surface(&qh);
    let layer = layer_shell.create_layer_surface(
        &qh,
        surface,
        Layer::Overlay,
        Some("openpets-pet"),
        None,
    );
    // Bottom-left anchored: the pet is placed with margins computed from the
    // output geometry so it lands at an arbitrary global (x, y).
    layer.set_anchor(Anchor::BOTTOM | Anchor::LEFT);
    // Never take keyboard focus — the pet is a passive overlay.
    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
    layer.set_size(args.width, args.height);
    // Initial commit (no buffer) maps the surface; a configure follows.
    layer.commit();

    // Give the pool room for several full frames so the buffer ring never
    // needs to grow at runtime.
    let pool = match SlotPool::new(
        (args.width as usize) * (args.height as usize) * 4 * 4,
        &shm,
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("openpets-wayland-helper: failed to create shm pool: {e}");
            std::process::exit(2);
        }
    };

    let mut app = App {
        registry_state: RegistryState::new(&globals),
        output_state: OutputState::new(&globals, &qh),
        seat_state: SeatState::new(&globals, &qh),
        shm,
        layer,
        _pointer: None,
        width: args.width,
        height: args.height,
        position: (args.x, args.y),
        visible: true,
        configured: false,
        output_geometry: None,
        pool,
        live_buffers: VecDeque::new(),
        client_writer: None,
        pending_frame: None,
        dragging: false,
        drag_prev_local: (0.0, 0.0),
    };

    // Start the socket reader thread. It forwards decoded messages to the main
    // thread over a channel; the main thread owns all Wayland state.
    let (tx, rx): (Sender<SocketEvent>, Receiver<SocketEvent>) = mpsc::channel();
    let reader_socket_path = args.socket_path.clone();
    thread::spawn(move || {
        if let Err(e) = run_socket_reader(&listener, &tx) {
            eprintln!("openpets-wayland-helper: socket reader stopped: {e}");
        }
        // Signal shutdown once the client is gone (or never connected in
        // time), then clean up the socket file.
        let _ = tx.send(SocketEvent::Disconnected);
        let _ = std::fs::remove_file(&reader_socket_path);
    });

    let mut exit = false;
    while !exit {
        // Non-blocking read + dispatch of Wayland events.
        if let Some(guard) = event_queue.prepare_read() {
            let mut pfd = libc::pollfd {
                fd: guard.connection_fd().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let n = unsafe { libc::poll(&mut pfd, 1, 10) };
            if n > 0 && (pfd.revents & libc::POLLIN) != 0 {
                let _ = guard.read();
            }
        }
        if let Err(e) = event_queue.dispatch_pending(&mut app) {
            eprintln!("openpets-wayland-helper: wayland dispatch error: {e}");
            break;
        }
        let _ = event_queue.flush();

        // Drain queued client events.
        while let Ok(event) = rx.try_recv() {
            exit = handle_socket_event(&mut app, event);
        }
    }

    let _ = std::fs::remove_file(&args.socket_path);
    eprintln!("openpets-wayland-helper: exiting");
}

/// Read length-prefixed messages from the connected client until EOF.
///
/// Gives up waiting for a client after `CONNECT_TIMEOUT` so a helper orphaned
/// before its owner connects does not hang forever.
fn run_socket_reader(listener: &UnixListener, tx: &Sender<SocketEvent>) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    // Wait for the single Electron client (non-blocking accept loop), giving
    // up after CONNECT_TIMEOUT so a helper orphaned before its owner connects
    // does not hang forever.
    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    let (stream, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    eprintln!("openpets-wayland-helper: no client connected within 15s; exiting");
                    return Ok(());
                }
                thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    };
    stream.set_read_timeout(Some(std::time::Duration::from_millis(50)))?;
    tx.send(SocketEvent::Connected(stream.try_clone()?))
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "channel closed"))?;
    let mut stream = stream;
    loop {
        match Message::read_from(&mut stream) {
            Ok(Some(msg)) => {
                if tx.send(SocketEvent::Message(msg)).is_err() {
                    return Ok(()); // main thread gone
                }
            }
            Ok(None) => return Ok(()), // clean EOF — client closed
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                eprintln!("openpets-wayland-helper: socket read error: {e}");
                return Ok(());
            }
        }
    }
}

/// Handle one socket event. Returns `true` when the helper should exit.
fn handle_socket_event(app: &mut App, event: SocketEvent) -> bool {
    match event {
        SocketEvent::Connected(stream) => {
            app.client_writer = Some(stream);
            if app.configured {
                let _ = app
                    .client_writer
                    .as_mut()
                    .map(|w| protocol::write_message(w, TAG_READY, &[]));
            }
            false
        }
        SocketEvent::Message(msg) => match msg {
            Message::Frame(frame) => {
                app.pending_frame = Some(frame);
                app.present_pending();
                false
            }
            Message::Move { x, y } => {
                app.position = (x, y);
                app.apply_position();
                debug_log(&format!("move to {x},{y}"));
                false
            }
            Message::Show => {
                if !app.visible {
                    app.visible = true;
                    app.recommit();
                }
                false
            }
            Message::Hide => {
                if app.visible {
                    app.visible = false;
                    // Attaching no buffer unmaps a layer-shell surface.
                    app.layer.attach(None, 0, 0);
                    app.layer.commit();
                }
                false
            }
            Message::Quit => true,
        },
        SocketEvent::Disconnected => {
            debug_log("client disconnected; shutting down");
            true
        }
    }
}

// ---------------------------------------------------------------------------
// Wayland trait implementations
// ---------------------------------------------------------------------------

impl CompositorHandler for App {
    fn scale_factor_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: i32) {}
    fn transform_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: wl_output::Transform) {}
    fn frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {}
    fn surface_enter(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}
    fn surface_leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _output: wl_output::WlOutput) {
        debug_log("new_output event");
        self.refresh_output_geometry();
    }
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {
        debug_log("update_output event");
        self.refresh_output_geometry();
    }
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.output_geometry = None;
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &LayerSurface) {
        eprintln!("openpets-wayland-helper: layer surface closed by compositor");
    }

    fn configure(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        // Respect the compositor's suggested size when it forces one.
        if configure.new_size.0 != 0 && configure.new_size.1 != 0 {
            self.width = configure.new_size.0;
            self.height = configure.new_size.1;
        }
        self.refresh_output_geometry();
        self.configured = true;
        self.apply_position();
        debug_log(&format!(
            "configured surface {}x{} at {:?}",
            self.width, self.height, self.position
        ));
        // If a frame was already queued, present it now that the surface is
        // configured.
        self.present_pending();
        // Notify the client it may start streaming.
        if let Some(writer) = self.client_writer.as_mut() {
            let _ = protocol::write_message(writer, TAG_READY, &[]);
        }
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

impl SeatHandler for App {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, qh: &QueueHandle<Self>, seat: wl_seat::WlSeat) {
        debug_log("new seat");
        if self._pointer.is_none() {
            self._pointer = self.seat_state.get_pointer(qh, &seat).ok();
            if self._pointer.is_some() {
                debug_log("pointer bound");
            }
        }
    }

    fn new_capability(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        debug_log(&format!("new capability: {capability:?}"));
        if capability == Capability::Pointer && self._pointer.is_none() {
            self._pointer = self.seat_state.get_pointer(qh, &seat).ok();
            if self._pointer.is_some() {
                debug_log("pointer bound");
            }
        }
    }

    fn remove_capability(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer {
            self._pointer = None;
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}

impl PointerHandler for App {
    fn pointer_frame(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            // Only handle events that target our layer surface.
            if &event.surface != self.layer.wl_surface() {
                continue;
            }
            let (x, y) = event.position;
            match &event.kind {
                PointerEventKind::Enter { .. } => self.send_pointer(PT_ENTER, x, y, 0),
                PointerEventKind::Leave { .. } => {
                    if self.dragging {
                        debug_log("drag ended (pointer left)");
                    }
                    self.dragging = false;
                    self.send_pointer(PT_LEAVE, x, y, 0);
                }
                PointerEventKind::Motion { .. } => {
                    // While dragging, move the surface directly (incrementally)
                    // so it follows the cursor without a renderer feedback
                    // loop. `drag_prev_local` is the previous frame's local
                    // cursor position; the delta equals the cursor's global
                    // movement because the surface has not moved since that
                    // frame.
                    if self.dragging {
                        let dx = x - self.drag_prev_local.0;
                        let dy = y - self.drag_prev_local.1;
                        self.drag_prev_local = (x, y);
                        self.position.0 += dx.round() as i32;
                        self.position.1 += dy.round() as i32;
                        self.apply_position();
                        self.send_position();
                    }
                    // Still forward motion so hover tracking works.
                    self.send_pointer(PT_MOVE, x, y, 0);
                }
                PointerEventKind::Press { button, .. } => {
                    // Left button (BTN_LEFT = 0x110 = 272) starts a drag.
                    if *button == 272 {
                        if !self.dragging {
                            debug_log(&format!("drag started at ({x:.0},{y:.0})"));
                        }
                        self.dragging = true;
                        self.drag_prev_local = (x, y);
                    }
                    self.send_pointer(PT_PRESS, x, y, *button);
                }
                PointerEventKind::Release { button, .. } => {
                    if *button == 272 {
                        if self.dragging {
                            debug_log(&format!(
                                "drag ended at ({}, {})",
                                self.position.0, self.position.1
                            ));
                        }
                        self.dragging = false;
                    }
                    self.send_pointer(PT_RELEASE, x, y, *button);
                }
                PointerEventKind::Axis { .. } => {}
            }
        }
    }
}

delegate_compositor!(App);
delegate_output!(App);
delegate_shm!(App);
delegate_layer!(App);
delegate_seat!(App);
delegate_pointer!(App);
delegate_registry!(App);

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

// ---------------------------------------------------------------------------
// Surface helpers
// ---------------------------------------------------------------------------

impl App {
    /// Forward a pointer input event to the Electron client so it can replay
    /// it into the (offscreen) pet renderer. Coordinates are surface-local.
    fn send_pointer(&mut self, kind: u8, x: f64, y: f64, button: u32) {
        let Some(writer) = self.client_writer.as_mut() else {
            return;
        };
        let mut payload = Vec::with_capacity(13);
        payload.push(kind);
        payload.extend_from_slice(&(x.round() as i32).to_le_bytes());
        payload.extend_from_slice(&(y.round() as i32).to_le_bytes());
        payload.extend_from_slice(&button.to_le_bytes());
        let _ = protocol::write_message(writer, TAG_POINTER, &payload);
    }

    /// Notify the client that the surface was repositioned (during a drag) so
    /// its tracked position stays in sync.
    fn send_position(&mut self) {
        let Some(writer) = self.client_writer.as_mut() else {
            return;
        };
        let mut payload = Vec::with_capacity(8);
        payload.extend_from_slice(&self.position.0.to_le_bytes());
        payload.extend_from_slice(&self.position.1.to_le_bytes());
        let _ = protocol::write_message(writer, TAG_POSITION, &payload);
    }

    /// Determine the primary output's logical geometry and cache it.
    fn refresh_output_geometry(&mut self) {
        let mut geometry = None;
        for output in self.output_state.outputs() {
            if let Some(info) = self.output_state.info(&output) {
                debug_log(&format!(
                    "output info: logical_pos={:?} logical_size={:?} location={:?} physical={:?} scale={} modes={:?}",
                    info.logical_position,
                    info.logical_size,
                    info.location,
                    info.physical_size,
                    info.scale_factor,
                    info.modes.iter().map(|m| m.dimensions).collect::<Vec<_>>()
                ));
                // Prefer logical geometry (matches layer-shell coordinates).
                if let (Some(pos), Some(size)) = (info.logical_position, info.logical_size) {
                    geometry = Some((pos.0, pos.1, size.0, size.1));
                    break;
                }
                // Fallback: derive logical geometry from physical location +
                // mode size + scale factor.
                let (lx, ly) = info.location;
                let scale = info.scale_factor.max(1) as i32;
                if let Some(mode) = info.modes.first() {
                    let (mw, mh) = mode.dimensions;
                    geometry = Some((lx / scale, ly / scale, mw / scale, mh / scale));
                    break;
                }
            }
        }
        if geometry != self.output_geometry {
            self.output_geometry = geometry;
            debug_log(&format!("output geometry resolved: {geometry:?}"));
            self.apply_position();
        }
    }

    /// Convert the desired global (x, y) into layer-shell margins and apply.
    fn apply_position(&mut self) {
        let Some((ox, oy, _ow, oh)) = self.output_geometry else {
            debug_log("apply_position: no output geometry yet");
            return;
        };
        let (x, y) = self.position;
        let left = x - ox;
        let bottom = (oy + oh) - (y + self.height as i32);
        // Negative margins are allowed so the pet can be dragged partly off the
        // output edges (mirrors the X11 behaviour); the compositor clamps the
        // surface at the edges if it does not support off-screen placement.
        self.layer.set_margin(0, 0, bottom, left);
        // `set_margin` only stages pending state — commit so the reposition
        // takes effect immediately (otherwise the surface only moves on the
        // next frame-stream commit, which stalls during a drag).
        self.layer.commit();
        debug_log(&format!("apply_position: margin left={left} bottom={bottom}"));
    }

    /// Present the latest pending frame onto the surface (if any and if
    /// configured and visible).
    fn present_pending(&mut self) {
        let Some(frame) = self.pending_frame.take() else {
            return;
        };
        if !self.configured || !self.visible {
            // Keep the frame buffered for when the surface becomes ready.
            self.pending_frame = Some(frame);
            return;
        }
        debug_log(&format!(
            "present frame {}x{} stride {}",
            frame.width, frame.height, frame.stride
        ));
        self.present_frame(&frame);
    }

    /// Present a frame from the client onto the surface.
    fn present_frame(&mut self, frame: &protocol::Frame) {
        if !self.configured {
            return;
        }
        // Surface size should match the frame; adjust if the renderer resized.
        if frame.width != self.width || frame.height != self.height {
            self.width = frame.width;
            self.height = frame.height;
            self.layer.set_size(self.width, self.height);
            self.apply_position();
        }

        let width = frame.width as i32;
        let height = frame.height as i32;
        let stride = frame.stride as i32;

        // Allocate a fresh buffer from the pool (slots are recycled once the
        // previous buffers are released by the compositor).
        let (buffer, canvas) = match self
            .pool
            .create_buffer(width, height, stride, wl_shm::Format::Argb8888)
        {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("openpets-wayland-helper: create buffer failed: {e}");
                return;
            }
        };

        // Copy BGRA (Electron) → premultiplied ARGB (wl_shm) bytes.
        // Chromium bitmaps carry straight alpha; wl_shm ARGB8888 is
        // premultiplied, so multiply RGB by A/255 to avoid bright fringes on
        // semi-transparent edges.
        copy_straight_bgra_to_premul_bgra(canvas, &frame.data);

        self.layer.wl_surface().damage_buffer(0, 0, width, height);
        if let Err(e) = buffer.attach_to(self.layer.wl_surface()) {
            eprintln!("openpets-wayland-helper: buffer attach failed: {e}");
            return;
        }
        self.layer.commit();

        // Keep this buffer alive until the compositor releases it; drop the
        // oldest once we hold more than a few.
        self.live_buffers.push_back(buffer);
        while self.live_buffers.len() > 4 {
            self.live_buffers.pop_front();
        }
    }

    /// Re-commit the last presented frame (used on show).
    fn recommit(&mut self) {
        if !self.visible {
            return;
        }
        // Re-present the latest buffered frame if we have one; otherwise
        // re-attach the last live buffer.
        if let Some(frame) = self.pending_frame.take() {
            self.present_frame(&frame);
            return;
        }
        let Some(last) = self.live_buffers.back() else {
            return;
        };
        if let Err(e) = last.attach_to(self.layer.wl_surface()) {
            eprintln!("openpets-wayland-helper: re-attach failed: {e}");
            return;
        }
        self.layer
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.layer.commit();
    }
}

/// Convert straight-alpha BGRA bytes (as produced by Electron
/// `NativeImage.toBitmap()`) into premultiplied BGRA for `wl_shm` ARGB8888.
fn copy_straight_bgra_to_premul_bgra(dst: &mut [u8], src: &[u8]) {
    let n = dst.len().min(src.len()) / 4;
    for i in 0..n {
        let b = src[i * 4];
        let g = src[i * 4 + 1];
        let r = src[i * 4 + 2];
        let a = src[i * 4 + 3];
        if a == 0 {
            dst[i * 4..i * 4 + 4].copy_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if a == 255 {
            dst[i * 4..i * 4 + 4].copy_from_slice(&[b, g, r, 255]);
            continue;
        }
        let a_f = a as u32;
        dst[i * 4] = ((b as u32 * a_f + 127) / 255) as u8;
        dst[i * 4 + 1] = ((g as u32 * a_f + 127) / 255) as u8;
        dst[i * 4 + 2] = ((r as u32 * a_f + 127) / 255) as u8;
        dst[i * 4 + 3] = a;
    }
}
