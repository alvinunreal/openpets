/// <reference types="@open-pets/plugin-sdk" />

let stopVocab = async () => {};

OpenPetsPlugin.register({
  async start(ctx) {
    await stopVocab();
    // Deduplicate event listeners during hot-reloads
    if (globalThis.__vocabUnsubscribe) {
      globalThis.__vocabUnsubscribe();
    }
    if (globalThis.__vocabConfigUnsubscribe) {
      globalThis.__vocabConfigUnsubscribe();
    }

    const COALESCE_WINDOW_MS = 300;
    let coalesceTimer = null;
    let pendingWord = null;
    let activeRequestId = 0;

    let currentProvider = "none";
    let isAnkiConnected = false;
    let ankiVersion = "";

    async function ankiRequest(action, params = {}) {
      try {
        const response = await ctx.net.fetch("http://127.0.0.1:8765", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, version: 6, params }),
        });

        if (!response.ok) {
          throw new Error(`AnkiConnect HTTP ${response.status}`);
        }

        let data = response.json;
        if (data === undefined) {
          try {
            data = JSON.parse(response.text || "{}");
          } catch {
            throw new Error("AnkiConnect returned non-JSON response");
          }
        }
        if (data && typeof data === "object" && data.error) throw new Error(data.error);
        return data && typeof data === "object" ? data.result : undefined;
      } catch (err) {
        console.error("Anki API Error:", err);
        if (ctx.log) ctx.log.error("Anki API Error details: " + err.message + "\n" + err.stack);
        throw err;
      }
    }

    async function checkAnkiConnection() {
      try {
        ankiVersion = await ankiRequest("version");
        isAnkiConnected = true;
        return true;
      } catch (e) {
        isAnkiConnected = false;
        return false;
      }
    }

    async function createDeckIfMissing(deckName) {
      const decks = await ankiRequest("deckNames");
      if (!decks.includes(deckName)) {
        await ankiRequest("createDeck", { deck: deckName });
      }
    }

    async function addToAnki(word, translation, definition, deckName) {
      await createDeckIfMissing(deckName);

      const query = `deck:"${deckName}" "Front:${word}"`;
      const notes = await ankiRequest("findNotes", { query });
      if (notes.length > 0) {
        throw new Error("Duplicate note found");
      }

      await ankiRequest("addNote", {
        note: {
          deckName: deckName,
          modelName: "Basic",
          fields: {
            "Front": word,
            "Back": `${translation}<br><br>${definition}`
          },
          options: {
            allowDuplicate: false
          }
        }
      });
    }

    const initialConfig = await ctx.config.get();
    currentProvider = initialConfig.provider || "none";
    if (currentProvider === "anki") {
      await checkAnkiConnection();
    }

    globalThis.__vocabConfigUnsubscribe = ctx.config.onChange(async (values) => {
      const newProvider = values.provider || "none";
      if (newProvider === "anki" && currentProvider !== "anki") {
        currentProvider = "anki";
        if (ctx.ui && ctx.ui.bubble) {
          const bubble = await ctx.ui.bubble({
            markdown: "You selected **Anki**. Click below to connect to AnkiConnect (ensure it's running on port 8765).",
            actions: [{ id: "connect_anki", label: "Connect to Anki" }]
          });
          bubble.onAction(async (id) => {
            if (id === "connect_anki") {
              await bubble.dismiss();
              if (ctx.pet.react) ctx.pet.react("thinking");
              const connected = await checkAnkiConnection();
              if (connected) {
                if (ctx.pet.react) ctx.pet.react("success");
                await ctx.ui.bubble({
                  markdown: `Successfully connected to **Anki** (version ${ankiVersion})!`,
                  actions: [{ id: "ok", label: "OK", dismissesBubble: true }]
                });
              } else {
                if (ctx.pet.react) ctx.pet.react("confused");
                await ctx.ui.bubble({
                  markdown: "Failed to connect to Anki. Please check that Anki is running and AnkiConnect is installed.",
                  actions: [{ id: "ok", label: "OK", dismissesBubble: true }]
                });
              }
            }
          });
        }
      } else {
        currentProvider = newProvider;
      }
    });

    function scheduleDrop(word) {
      pendingWord = word;
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        const wordToProcess = pendingWord;
        pendingWord = null;
        processDrop(wordToProcess);
      }, COALESCE_WINDOW_MS);
    }

    async function processDrop(word) {
      const requestId = ++activeRequestId;

      try {
        if (ctx.pet.react) ctx.pet.react("thinking");
        if (requestId !== activeRequestId) return;

        const config = await ctx.config.get();
        const targetLang = config.preferredLanguage || "es";
        currentProvider = config.provider || "none";

        const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
        const transUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(word)}`;

        if(ctx.log) ctx.log.info('Provider: ' + currentProvider + ', connected: ' + isAnkiConnected); const [dictRes, transRes] = await Promise.all([
          ctx.net.fetch(dictUrl),
          ctx.net.fetch(transUrl)
        ]);

        if (requestId !== activeRequestId) return;

        let transData, dictData;
        try { transData = JSON.parse(transRes.text); } catch (e) {}
        try { dictData = JSON.parse(dictRes.text); } catch (e) {}

        const translation = Array.isArray(transData) ? transData[0]?.[0]?.[0] : undefined;

        if (!translation) {
          if (ctx.pet.react) ctx.pet.react("confused");
          if (ctx.pet.speak) await ctx.pet.speak(`Translation parsing error for '${word}'`);
          return;
        }

        if (requestId !== activeRequestId) return;

        if (ctx.pet.react) ctx.pet.react("success");

        if (ctx.ui && ctx.ui.bubble) {
          if (globalThis.__vocabBubbleHandle) {
            try { await globalThis.__vocabBubbleHandle.dismiss(); } catch (e) {}
            globalThis.__vocabBubbleHandle = null;
          }

          let shortDef = "No definition found.";
          let pos = "";
          if (Array.isArray(dictData) && dictData.length > 0) {
            const meanings = dictData[0].meanings || [];
            if (meanings.length > 0) {
              const meaning = meanings[0];
              pos = meaning.partOfSpeech ? `*(${meaning.partOfSpeech})* ` : "";
              const defs = meaning.definitions || [];
              if (defs.length > 0 && defs[0].definition) {
                shortDef = defs[0].definition;
              }
            }
          }

          if (shortDef.length > 250) {
            shortDef = shortDef.substring(0, 247).trim() + "...";
          }

          const markdownText = `**${word.toUpperCase()}** — ${translation}\n${pos}${shortDef}`;

          if (ctx.log && ctx.log.info) ctx.log.info(`Spawning bubble for word: ${word}`);

          if (currentProvider === "anki") {
             // Seamless connection attempt for logging and status
             if (!isAnkiConnected) checkAnkiConnection();
          }

          let actions = [
            { id: "close_card", label: "Close", dismissesBubble: true }
          ];

          if (currentProvider === "anki") {
            actions.unshift({ id: "add_to_anki", label: "Add to Anki" });
          }

          globalThis.__vocabBubbleHandle = await ctx.ui.bubble({
            markdown: markdownText,
            actions: actions
          });

          globalThis.__vocabBubbleHandle.onAction(async (actionId) => {
            if (actionId === "add_to_anki") {
              try {
                if (globalThis.__vocabBubbleHandle) {
                  try { await globalThis.__vocabBubbleHandle.dismiss(); } catch(e) {}
                  globalThis.__vocabBubbleHandle = null;
                }
                
                if (ctx.pet.react) ctx.pet.react("thinking");
                
                if (!isAnkiConnected) {
                  const connected = await checkAnkiConnection();
                  if (!connected) {
                    throw new Error("Could not connect to Anki via 127.0.0.1:8765. Make sure Anki is running and AnkiConnect is installed.");
                  }
                }

                const currentCfg = await ctx.config.get();
                const deckName = currentCfg.ankiDeck || "OpenPets Vocab";
                await addToAnki(word, translation, `${pos}${shortDef}`, deckName);
                if (ctx.pet.react) ctx.pet.react("success");
                await ctx.ui.bubble({
                  markdown: `Saved **${word}** to deck *${deckName}*!`,
                  actions: [{ id: "ok", label: "OK", dismissesBubble: true }]
                });
              } catch (e) {
                if (ctx.pet.react) ctx.pet.react("confused");
                await ctx.ui.bubble({
                  markdown: `Failed to add **${word}**: ${e.message}`,
                  actions: [{ id: "ok", label: "OK", dismissesBubble: true }]
                });
              }
            }
          });

          if (ctx.log && ctx.log.info) ctx.log.info(`Bubble spawned successfully for word: ${word}`);
        }
      } catch (networkError) {
        if (requestId !== activeRequestId) return; 
        if (ctx.pet.react) ctx.pet.react("confused");
        const errMsg = (networkError instanceof Error ? networkError.message : String(networkError)).replace(/\n/g, ' ');
        if (ctx.pet.speak) {
          await ctx.pet.speak(`Exception for '${word}': ${errMsg}`);
        }
        if (ctx.log && ctx.log.error) {
          ctx.log.error("Network fetch failed:", networkError);
        }
      }
    }

    globalThis.__vocabUnsubscribe = ctx.events.on("pet:drop", (event) => {
      try {
        if (ctx.log && ctx.log.info) ctx.log.info("Received pet:drop event");
        const droppedText = event.data?.text || event.text;
        if (typeof droppedText !== "string") return;

        const cleanText = droppedText.replace(/[^\w\s]/g, "").trim().toLowerCase();
        const firstWord = cleanText.split(/\s+/)[0];
        if (!firstWord) return;

        if (ctx.log && ctx.log.info) ctx.log.info(`Extracted word: ${firstWord}, scheduling drop`);
        scheduleDrop(firstWord);
      } catch (error) {
        if (ctx.log && ctx.log.error) {
          ctx.log.error("Error processing pet:drop event:", error);
        }
      }
    });

    stopVocab = async () => {
      if (globalThis.__vocabUnsubscribe) {
        globalThis.__vocabUnsubscribe();
        globalThis.__vocabUnsubscribe = null;
      }
      if (globalThis.__vocabConfigUnsubscribe) {
        globalThis.__vocabConfigUnsubscribe();
        globalThis.__vocabConfigUnsubscribe = null;
      }
      if (globalThis.__vocabBubbleHandle) {
        try { await globalThis.__vocabBubbleHandle.dismiss(); } catch (e) {}
        globalThis.__vocabBubbleHandle = null;
      }
    };
  },
  async stop() {
    await stopVocab();
    stopVocab = async () => {};
  }
});
