//! Framing protocol shared by the Electron main process (client) and this
//! helper (server) over a Unix domain socket.
//!
//! Every message is length-prefixed: a little-endian `u32` byte count followed
//! by that many payload bytes. The first payload byte is a message-type tag.
//!
//! Client → helper:
//! - `FRAME` (0x01): width(u32) height(u32) stride(u32) then `stride * height`
//!   bytes of BGRA pixels (matches Electron `NativeImage.toBitmap()`).
//! - `MOVE` (0x02): x(i32) y(i32) — top-left corner in global compositor
//!   (logical) coordinates.
//! - `SHOW` (0x03): map the layer-shell surface.
//! - `HIDE` (0x04): unmap the layer-shell surface.
//! - `QUIT` (0x05): shut down cleanly.
//!
//! Helper → client:
//! - `READY` (0x81): sent once the layer-shell surface has received its first
//!   configure and is ready to accept frames.

use std::io::{self, Read, Write};

pub const TAG_FRAME: u8 = 0x01;
pub const TAG_MOVE: u8 = 0x02;
pub const TAG_SHOW: u8 = 0x03;
pub const TAG_HIDE: u8 = 0x04;
pub const TAG_QUIT: u8 = 0x05;
pub const TAG_READY: u8 = 0x81;

/// A frame payload delivered by the Electron client.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub data: Vec<u8>,
}

/// One decoded message from the client.
pub enum Message {
    Frame(Frame),
    Move { x: i32, y: i32 },
    Show,
    Hide,
    Quit,
}

impl Message {
    /// Read one length-prefixed message from `reader`.
    ///
    /// Returns `Ok(None)` on a clean EOF at a message boundary (client closed
    /// the socket between messages), which callers treat as "shut down".
    pub fn read_from(reader: &mut impl Read) -> io::Result<Option<Message>> {
        let mut len_buf = [0u8; 4];
        match read_exact_or_eof(reader, &mut len_buf)? {
            false => return Ok(None),
            true => {}
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > 64 * 1024 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid message length"));
        }
        let mut payload = vec![0u8; len];
        read_exact_or_eof(reader, &mut payload)?
            .then_some(())
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated message"))?;

        let tag = payload[0];
        match tag {
            TAG_FRAME => {
                let body = &payload[1..];
                if body.len() < 12 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "short frame"));
                }
                let width = u32::from_le_bytes(body[0..4].try_into().unwrap());
                let height = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let stride = u32::from_le_bytes(body[8..12].try_into().unwrap());
                let expected = stride as usize * height as usize;
                if body.len() != 12 + expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "frame pixel data length mismatch",
                    ));
                }
                Ok(Some(Message::Frame(Frame {
                    width,
                    height,
                    stride,
                    data: body[12..].to_vec(),
                })))
            }
            TAG_MOVE => {
                let body = &payload[1..];
                if body.len() < 8 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "short move"));
                }
                let x = i32::from_le_bytes(body[0..4].try_into().unwrap());
                let y = i32::from_le_bytes(body[4..8].try_into().unwrap());
                Ok(Some(Message::Move { x, y }))
            }
            TAG_SHOW => Ok(Some(Message::Show)),
            TAG_HIDE => Ok(Some(Message::Hide)),
            TAG_QUIT => Ok(Some(Message::Quit)),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown message tag 0x{other:02x}"),
            )),
        }
    }
}

/// Write a length-prefixed message with the given tag + payload.
pub fn write_message(writer: &mut impl Write, tag: u8, payload: &[u8]) -> io::Result<()> {
    let len = payload.len() + 1;
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(tag);
    out.extend_from_slice(payload);
    writer.write_all(&out)
}

/// Read exactly `buf.len()` bytes, returning `Ok(false)` if the stream ends
/// cleanly before any byte is read.
fn read_exact_or_eof(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream ended mid-message",
                ));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
