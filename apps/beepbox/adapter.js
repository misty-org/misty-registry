(function () {
  "use strict";

  var EXTENSION = ".beepbox";
  var MIME = "application/json";
  var SAVE_AFTER_MS = 1000;

  function deferred() {
    var parts = {};
    parts.promise = new Promise(function (resolve, reject) {
      parts.resolve = resolve;
      parts.reject = reject;
    });
    parts.promise.catch(function () {});
    return parts;
  }

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function parse(text) {
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  var editorReady = deferred();
  var song = null;
  var misty = null;
  var lastHash = "";
  var onLocalChange = null;
  var fileName = "";

  document.addEventListener(
    "load",
    function (event) {
      var target = event.target;
      if (!target || target.tagName !== "SCRIPT" || !/beepbox_editor(\.min)?\.js$/.test(target.src || "")) return;
      setTimeout(function () {
        var found = typeof editor !== "undefined" ? editor : null;
        if (found && found.doc) editorReady.resolve(found.doc);
        else editorReady.reject(new Error("BeepBox didn't start."));
      }, 0);
    },
    true,
  );

  function normalized(json) {
    var next = new window.beepbox.Song();
    next.fromJsonObject(object(json));
    return next;
  }

  function currentJson() {
    return song.song.toJsonObject();
  }

  function songText() {
    return JSON.stringify(currentJson(), null, 2);
  }

  function show(hash) {
    lastHash = hash;
    window.location.hash = hash;
  }

  function showJson(json) {
    var next = normalized(json);
    var hash = next.toBase64String();
    if (hash !== lastHash) show(hash);
  }

  function onSongChange() {
    var hash;
    try {
      hash = song.song.toBase64String();
    } catch (error) {
      return;
    }
    if (hash === lastHash) return;
    lastHash = hash;
    if (onLocalChange) onLocalChange();
  }

  var opened = null;

  function sdk() {
    return new Promise(function (resolve) {
      var check = function () {
        resolve(window.MistySDK && typeof window.MistySDK.connect === "function" ? window.MistySDK : null);
      };
      if (window.MistySDK || document.readyState !== "loading") check();
      else document.addEventListener("DOMContentLoaded", check, { once: true });
    });
  }

  function start() {
    var module = null;
    var connected = sdk().then(function (found) {
      module = found;
      if (!found) return null;
      return found.connect({ applyTheme: false }).catch(function () { return null; });
    });
    Promise.all([editorReady.promise, connected]).then(function (results) {
      song = results[0];
      misty = results[1];
      try {
        lastHash = song.song.toBase64String();
      } catch (error) {
        lastHash = "";
      }
      song.notifier.watch(onSongChange);
      if (!misty) return;
      opened = module.openDocument(misty, {
        extension: EXTENSION,
        mime: MIME,
        name: "Song",
        liveRooms: false,
        saveAfterMs: SAVE_AFTER_MS,
        load: function () {},
        serialize: songText,
        current: songText,
        show: function (data) {
          var json = parse(new TextDecoder().decode(data));
          if (json) showJson(json);
        },
        live: function () {},
      });
      opened.onFile(function (file) {
        fileName = file.name || fileName;
      });
      onLocalChange = function () {
        opened.changed();
      };
    }).catch(function () {});
  }

  start();

  function needSong() {
    if (!song) throw new Error("BeepBox is still starting. Try again in a moment.");
    return song;
  }

  function summary() {
    var json = currentJson();
    var channels = Array.isArray(json.channels) ? json.channels : [];
    return {
      file: fileName || null,
      playing: !!(song.synth && song.synth.playing),
      scale: json.scale,
      key: json.key,
      beats_per_minute: json.beatsPerMinute,
      beats_per_bar: json.beatsPerBar,
      ticks_per_beat: json.ticksPerBeat,
      intro_bars: json.introBars,
      loop_bars: json.loopBars,
      bars: channels.length ? (channels[0].sequence || []).length : 0,
      channels: channels.map(function (channel, index) {
        return {
          index: index,
          type: channel.type,
          instruments: (channel.instruments || []).map(function (instrument) { return instrument.type; }),
          patterns: (channel.patterns || []).length,
          sequence: channel.sequence || [],
        };
      }),
    };
  }

  var tools = [
    {
      name: "read_song",
      description: "Read the open BeepBox song: its tempo, key, scale, bars and each channel's instruments, patterns and the pattern each bar plays. Pass full to get the whole song as BeepBox's own JSON, the same JSON write_song takes.",
      inputSchema: {
        type: "object",
        properties: { full: { type: "boolean", description: "Return the whole song as BeepBox JSON." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_song",
      description: "Replace the open song with BeepBox JSON, as BeepBox's own export writes it (read it first with read_song and full). It is saved in the Space's file.",
      inputSchema: {
        type: "object",
        properties: { song: { type: "object", description: "The whole song as BeepBox JSON." } },
        required: ["song"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "play",
      description: "Play the song from where the playhead is.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
    {
      name: "pause",
      description: "Pause the song.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
  ];

  function call(name, args) {
    var input = object(args);
    var current = needSong();
    switch (name) {
      case "read_song":
        return input.full ? currentJson() : summary();
      case "write_song": {
        var json = object(input.song);
        if (!Array.isArray(json.channels)) throw new Error("The song needs its channels, as read_song with full returns them.");
        var next = normalized(json);
        window.location.hash = next.toBase64String();
        return { ok: true };
      }
      case "play":
        current.performance.play();
        return { playing: true };
      case "pause":
        current.performance.pause();
        return { playing: false };
      default:
        throw new Error("BeepBox has no tool called " + name + ".");
    }
  }

  window.mistyAdapter = { tools: tools, call: call };
})();
