(function () {
  "use strict";

  var MIME = "application/pdf";
  var SAVE_AFTER_MS = 1500;
  var MAX_PAGES_READ = 20;
  var MAX_MATCHES = 50;

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

  function quiet() {
    var options = window.PDFViewerApplicationOptions;
    if (!options || typeof options.set !== "function") return;
    options.set("defaultUrl", "");
    options.set("disableHistory", true);
  }

  document.addEventListener("webviewerloaded", quiet);

  var viewerReady = deferred();
  var viewer = null;
  var misty = null;
  var room = null;
  var file = null;
  var opening = Promise.resolve();

  window.addEventListener("load", function () {
    var found = window.PDFViewerApplication;
    if (!found || !found.initializedPromise) {
      viewerReady.reject(new Error("PDF.js didn't start."));
      return;
    }
    found.initializedPromise.then(function () { viewerReady.resolve(found); });
  });

  function storage() {
    var pdf = viewer && viewer.pdfDocument;
    return pdf ? pdf.annotationStorage : null;
  }

  function modified() {
    var store = storage();
    return !!(store && store.modified);
  }

  var opened = null;

  function watchEdits() {
    var store = storage();
    if (!store || store.mistyWatched) return;
    store.mistyWatched = true;
    var original = store.onSetModified;
    store.onSetModified = function () {
      if (typeof original === "function") original.apply(this, arguments);
      if (opened) opened.changed();
    };
  }

  function show(data, page) {
    opening = opening.then(function () {
      return viewer.open({ data: new Uint8Array(data) }).then(function () {
        watchEdits();
        if (page && viewer.pagesCount >= page) viewer.page = page;
      });
    });
    return opening;
  }

  function joinRoom(fileId) {
    try {
      room = misty.room("file:" + fileId);
    } catch (error) {
      room = null;
      return;
    }
    var publish = function () {
      if (room && room.awareness) room.awareness.setLocalStateField("pdf", { page: viewer.page });
    };
    viewer.eventBus.on("pagechanging", publish);
    Promise.resolve(room.ready || room.synced).then(publish).catch(function () {});
  }

  function people() {
    if (!room || !room.awareness) return [];
    var mine = room.awareness.clientID;
    var found = [];
    room.awareness.getStates().forEach(function (state, clientId) {
      if (clientId === mine) return;
      var who = room.identity ? room.identity(clientId) : null;
      var pdf = object(object(state).pdf);
      found.push({ name: who ? who.name : "Someone", page: typeof pdf.page === "number" ? pdf.page : null });
    });
    return found;
  }

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
    Promise.all([viewerReady.promise, connected]).then(function (results) {
      viewer = results[0];
      misty = results[1];
      viewer.eventBus.on("documentloaded", watchEdits);
      if (!misty) return;
      var permissions = Array.isArray(misty.permissions) ? misty.permissions : [];
      var joined = false;
      opened = module.openDocument(misty, {
        extension: ".pdf",
        mime: MIME,
        name: "Document",
        liveRooms: false,
        saveAfterMs: SAVE_AFTER_MS,
        load: function () {},
        serialize: function () { return new Uint8Array(0); },
        current: function () {
          var pdf = viewer.pdfDocument;
          if (!pdf) throw new Error("No PDF is open.");
          return pdf.saveDocument();
        },
        show: function (data, shown) {
          document.title = shown.name;
          return show(data, viewer.page);
        },
        live: function () {},
      });
      opened.onFile(function (shown) {
        file = shown;
        var store = storage();
        if (store && typeof store.resetModified === "function") store.resetModified();
        if (!joined && permissions.indexOf("rooms") >= 0) {
          joined = true;
          joinRoom(shown.id);
        }
      });
    }).catch(function () {});
  }

  start();

  function needDocument() {
    if (!viewer || !viewer.pdfDocument) throw new Error("No PDF is open yet. Open one from the Space's files.");
    return viewer.pdfDocument;
  }

  function pageNumber(value, pdf) {
    var number = Math.floor(Number(value));
    if (!number || number < 1 || number > pdf.numPages) throw new Error("This PDF has pages 1 to " + pdf.numPages + ".");
    return number;
  }

  function pageText(pdf, number) {
    return pdf.getPage(number).then(function (page) {
      return page.getTextContent().then(function (content) {
        return content.items
          .map(function (item) { return (item.str || "") + (item.hasEOL ? "\n" : ""); })
          .join("");
      });
    });
  }

  var tools = [
    {
      name: "read_info",
      description: "Read what PDF is open: its file name, title, number of pages, the page in view, whether it has markup not yet saved, and which page each other person with it open is on.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "read_text",
      description: "Read the text of pages of the open PDF, from page to through (at most 20 pages at once).",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number", description: "The first page, from 1." },
          through: { type: "number", description: "The last page; the first one when left out." },
        },
        required: ["page"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "find",
      description: "Find text in the open PDF: the pages it is on, each with the line around it.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "go_to_page",
      description: "Show a page of the open PDF.",
      inputSchema: {
        type: "object",
        properties: { page: { type: "number" } },
        required: ["page"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
  ];

  function call(name, args) {
    var input = object(args);
    switch (name) {
      case "read_info": {
        var pdf = needDocument();
        return pdf.getMetadata().catch(function () { return {}; }).then(function (meta) {
          var info = object(object(meta).info);
          return {
            file: file ? file.name : null,
            title: info.Title || null,
            pages: pdf.numPages,
            page: viewer.page,
            unsaved: modified(),
            people: people(),
          };
        });
      }
      case "read_text": {
        var doc = needDocument();
        var first = pageNumber(input.page, doc);
        var last = input.through === undefined ? first : pageNumber(input.through, doc);
        if (last < first) throw new Error("through comes after page.");
        last = Math.min(last, first + MAX_PAGES_READ - 1);
        var reads = [];
        for (var number = first; number <= last; number++) {
          reads.push(
            (function (at) {
              return pageText(doc, at).then(function (text) { return { page: at, text: text }; });
            })(number),
          );
        }
        return Promise.all(reads).then(function (pages) { return { pages: pages }; });
      }
      case "find": {
        var searched = needDocument();
        var wanted = typeof input.text === "string" ? input.text.toLowerCase() : "";
        if (!wanted) throw new Error("Say what text to find.");
        var matches = [];
        var step = function (at) {
          if (at > searched.numPages || matches.length >= MAX_MATCHES) return Promise.resolve({ matches: matches });
          return pageText(searched, at).then(function (text) {
            text.split("\n").forEach(function (line) {
              if (matches.length < MAX_MATCHES && line.toLowerCase().indexOf(wanted) >= 0) {
                matches.push({ page: at, line: line.trim().slice(0, 300) });
              }
            });
            return step(at + 1);
          });
        };
        return step(1);
      }
      case "go_to_page": {
        var shown = needDocument();
        viewer.page = pageNumber(input.page, shown);
        return { page: viewer.page };
      }
      default:
        throw new Error("PDF.js has no tool called " + name + ".");
    }
  }

  var context = document.modelContext;
  if (context && typeof context.registerTool === "function") {
    tools.forEach(function (tool) {
      context.registerTool({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: function (input, options) { return call(tool.name, input, options || {}); },
      }).catch(function () {});
    });
  } else {
    window.mistyAdapter = { tools: tools, call: call };
  }
})();
