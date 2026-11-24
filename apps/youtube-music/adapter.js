(function () {
  "use strict";
  if (location.hostname !== "music.youtube.com") return;
  var ROOM = "listening";
  var DRIFT_SECONDS = 3;
  var QUIET_MS = 1500;

  function find(selector) {
    return document.querySelector(selector);
  }

  function words(element) {
    return element ? String(element.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function media() {
    return find("video");
  }

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function videoId() {
    var here = new URL(location.href).searchParams.get("v");
    if (here) return here;
    var link = find("ytmusic-player-bar a[href*='watch?v=']");
    if (!link) return null;
    try {
      return new URL(link.href, location.href).searchParams.get("v");
    } catch (error) {
      return null;
    }
  }

  function nowPlaying() {
    var bar = find("ytmusic-player-bar");
    var player = media();
    return {
      title: words(bar && bar.querySelector(".title")),
      artist: words(bar && bar.querySelector(".byline")),
      video_id: videoId(),
      playing: Boolean(player && !player.paused),
      position: player ? Math.round(player.currentTime) : 0,
      duration: player && isFinite(player.duration) ? Math.round(player.duration) : null,
    };
  }

  function press(selector, what) {
    var button = find(selector);
    if (!button) throw new Error("YouTube Music has no " + what + " button right now.");
    button.click();
  }

  function play() {
    var player = media();
    if (player && !player.paused) return nowPlaying();
    press("ytmusic-player-bar #play-pause-button", "play");
    return nowPlaying();
  }

  function pause() {
    var player = media();
    if (player && !player.paused) press("ytmusic-player-bar #play-pause-button", "pause");
    return nowPlaying();
  }

  function queue() {
    var items = Array.prototype.slice.call(document.querySelectorAll("ytmusic-player-queue-item"), 0, 50);
    return {
      tracks: items.map(function (item, index) {
        return {
          position: index + 1,
          title: words(item.querySelector(".song-title")),
          artist: words(item.querySelector(".byline")),
          playing: item.hasAttribute("selected") || item.getAttribute("play-button-state") === "playing",
        };
      }),
    };
  }

  function playQueued(position) {
    var items = document.querySelectorAll("ytmusic-player-queue-item");
    var item = items[position - 1];
    if (!item) throw new Error("The queue has no track " + position + ".");
    var target = item.querySelector(".song-title") || item;
    target.click();
    return nowPlaying();
  }

  function openTrack(id, seconds) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error("That isn't a YouTube Music track id.");
    var address = "https://music.youtube.com/watch?v=" + encodeURIComponent(id);
    if (seconds > 0) address += "&t=" + Math.floor(seconds) + "s";
    location.assign(address);
  }

  var misty = null;
  var room = null;
  var session = null;
  var me = null;
  var following = true;
  var quietUntil = 0;

  function quiet() {
    quietUntil = Date.now() + QUIET_MS;
  }

  function publishPresence() {
    if (!room) return;
    var now = nowPlaying();
    room.awareness.setLocalStateField("listening", now.title ? { title: now.title, artist: now.artist } : null);
  }

  function publish() {
    if (!session || !me || Date.now() < quietUntil) return;
    var now = nowPlaying();
    if (!now.video_id) return;
    room.doc.transact(function () {
      session.set("leader", me.user_id);
      session.set("leader_name", me.name);
      session.set("video", now.video_id);
      session.set("time", now.position);
      session.set("playing", now.playing);
      session.set("at", Date.now());
      session.set("title", now.title);
      session.set("artist", now.artist);
    });
  }

  function follow() {
    if (!session || !me || !following) return;
    var shared = session.toJSON();
    if (!shared.video || shared.leader === me.user_id) return;
    var expected = Number(shared.time) || 0;
    if (shared.playing) expected += (Date.now() - (Number(shared.at) || Date.now())) / 1000;
    quiet();
    if (videoId() !== shared.video) return openTrack(shared.video, expected);
    var player = media();
    if (!player) return;
    if (Math.abs(player.currentTime - expected) > DRIFT_SECONDS) player.currentTime = expected;
    if (shared.playing && player.paused) press("ytmusic-player-bar #play-pause-button", "play");
    if (!shared.playing && !player.paused) press("ytmusic-player-bar #play-pause-button", "pause");
  }

  function listeners() {
    if (!room) return { listeners: [] };
    var list = [];
    room.awareness.getStates().forEach(function (state, client) {
      var who = room.identity(client);
      if (state && state.listening && who) list.push({ name: who.name, title: state.listening.title, artist: state.listening.artist });
    });
    var shared = session ? session.toJSON() : {};
    return { listeners: list, leading: shared.leader_name || null, following: following };
  }

  var lastTrack = "";
  function watchPlayer() {
    var player = media();
    if (!player || player.__mistyWatched) return;
    player.__mistyWatched = true;
    ["play", "pause", "seeked"].forEach(function (name) {
      player.addEventListener(name, publish);
    });
    player.addEventListener("loadeddata", function () {
      var track = videoId() || "";
      publishPresence();
      if (track !== lastTrack) {
        lastTrack = track;
        publish();
      }
    });
  }

  new MutationObserver(function () {
    watchPlayer();
  }).observe(document.documentElement, { childList: true, subtree: true });
  watchPlayer();

  function connect() {
    var host = window.mistyAdapterHost;
    if (!host || typeof host.connect !== "function") return;
    host
      .connect()
      .then(function (connected) {
        misty = connected;
        me = misty.me();
        room = misty.room(ROOM);
        session = room.doc.getMap("session");
        session.observe(follow);
        return room.synced.then(function () {
          lastTrack = videoId() || "";
          publishPresence();
          follow();
        });
      })
      .catch(function () {
        misty = null;
      });
  }
  connect();

  var tools = [
    {
      name: "now_playing",
      description: "What YouTube Music is playing now: the track's title, artist, id, whether it plays, and where it is, in seconds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "play",
      description: "Play, or carry on playing, the current track.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "pause",
      description: "Pause the current track.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "next",
      description: "Skip to the next track in the queue.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "previous",
      description: "Go back to the previous track.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "queue",
      description: "The queue that's showing: each track's position, title, artist and whether it plays now.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "play_from_queue",
      description: "Play the track at a position in the queue, from queue.",
      inputSchema: {
        type: "object",
        properties: { position: { type: "number", description: "The track's position, from 1." } },
        required: ["position"],
        additionalProperties: false,
      },
    },
    {
      name: "play_track",
      description: "Open and play a track by its YouTube Music id (the v= of its address).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The track's id." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "listen_together",
      description: "Follow the Space's shared listening, or stop following it and play on your own. Whoever plays, pauses or skips leads.",
      inputSchema: {
        type: "object",
        properties: { on: { type: "boolean", description: "Whether to follow." } },
        required: ["on"],
        additionalProperties: false,
      },
    },
    {
      name: "listeners",
      description: "Who in the Space is listening, to what, and who leads the shared listening.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ];

  function call(name, args) {
    var input = object(args);
    switch (name) {
      case "now_playing":
        return nowPlaying();
      case "play":
        return play();
      case "pause":
        return pause();
      case "next":
        press("ytmusic-player-bar .next-button", "next");
        return nowPlaying();
      case "previous":
        press("ytmusic-player-bar .previous-button", "previous");
        return nowPlaying();
      case "queue":
        return queue();
      case "play_from_queue":
        if (typeof input.position !== "number" || input.position < 1) throw new Error("Give the track's position, from 1.");
        return playQueued(Math.floor(input.position));
      case "play_track":
        openTrack(input.id, 0);
        return { opening: input.id };
      case "listen_together":
        following = input.on === true;
        if (following) follow();
        return listeners();
      case "listeners":
        return listeners();
      default:
        throw new Error("YouTube Music has no tool called " + name + ".");
    }
  }

  window.mistyAdapter = { tools: tools, call: call };
})();
