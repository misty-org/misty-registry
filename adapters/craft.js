(function () {
  "use strict";

  var MIMES = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    psd: "image/vnd.adobe.photoshop",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    rtf: "application/rtf",
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
    dxf: "image/vnd.dxf",
    svgz: "image/svg+xml",
  };

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

  function mimeOf(name) {
    var match = /\.([A-Za-z0-9]+)$/.exec(name || "");
    return (match && MIMES[match[1].toLowerCase()]) || "application/octet-stream";
  }

  function splitName(name) {
    var match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(name);
    return { base: match[1] || name, extension: match[2] || "" };
  }

  var app = "";
  var label = "";
  var canvas = null;
  var connected = deferred();
  var misty = null;
  var current = null;
  var savedAt = "";
  var dirty = false;
  var hostSeen = false;
  var started = false;
  var pendingOpen = null;
  var unwatch = null;

  function emit(kind, detail) {
    if (!canvas) return;
    canvas.dispatchEvent(new CustomEvent(app + ":" + kind, { detail: detail }));
  }

  function setCurrent(file) {
    current = file;
    savedAt = file.updated_at || "";
    if (unwatch) unwatch();
    unwatch = misty.files.watch(
      function (change) {
        if (!current || change.kind !== "changed" || change.file.id !== current.id) return;
        if (change.file.updated_at === savedAt) return;
        current = change.file;
        savedAt = change.file.updated_at;
        if (!dirty) reopen();
      },
      current.folder ? { folder: current.folder } : undefined,
    );
  }

  function reopen() {
    misty.files.download(current.id).then(function (got) {
      if (dirty) return;
      openBytes(got.file.name, got.data);
    }).catch(function () {});
  }

  function dropFile(name, data) {
    if (!canvas || typeof DataTransfer !== "function") return;
    var transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: mimeOf(name) }));
    var init = { bubbles: true, cancelable: true, dataTransfer: transfer };
    canvas.dispatchEvent(new DragEvent("dragenter", init));
    canvas.dispatchEvent(new DragEvent("dragover", init));
    canvas.dispatchEvent(new DragEvent("drop", init));
  }

  function openBytes(name, data) {
    if (hostSeen) {
      emit("open", { name: name, bytes: data.slice(0) });
      return;
    }
    if (started) {
      dropFile(name, data);
      return;
    }
    pendingOpen = { name: name, data: data };
  }

  function uniqueName(folder, name) {
    var taken = new Set();
    var page = function (cursor, left) {
      return misty.files.list({ folder: folder, cursor: cursor }).then(function (result) {
        (result.files || []).forEach(function (file) { taken.add(String(file.name).toLowerCase()); });
        if (result.next_cursor && left > 0) return page(result.next_cursor, left - 1);
      });
    };
    return page(undefined, 20).then(function () {
      if (!taken.has(name.toLowerCase())) return name;
      var parts = splitName(name);
      for (var number = 2; ; number++) {
        var next = parts.base + " " + number + parts.extension;
        if (!taken.has(next.toLowerCase())) return next;
      }
    });
  }

  function download(name, data) {
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: mimeOf(name) }));
    link.download = name;
    originalAnchorClick.call(link);
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 60000);
  }

  function saveToSpace(name, data, becomesFile) {
    var replacing = current && name.toLowerCase() === String(current.name).toLowerCase();
    var folder = current ? current.folder : undefined;
    var named = replacing ? Promise.resolve(current.name) : uniqueName(folder, name);
    return named.then(function (finalName) {
      return misty.files.save({
        name: finalName,
        mime: replacing && current.mime ? current.mime : mimeOf(finalName),
        folder: folder,
        data: data,
      });
    }).then(function (file) {
      if (replacing || becomesFile || !current) setCurrent(file);
      else if (current && file.id === current.id) savedAt = file.updated_at || savedAt;
      return file;
    });
  }

  function onSave(event) {
    var detail = object(event.detail);
    var name = typeof detail.name === "string" && detail.name ? detail.name : "document";
    var bytes = detail.bytes;
    if (!bytes) return;
    connected.promise.then(function () {
      if (!misty) {
        download(name, bytes);
        return;
      }
      return saveToSpace(name, bytes, detail.saveAs === true).then(function () {
        if (typeof detail.id === "string") emit("saved", { id: detail.id });
      });
    }).catch(function () {});
  }

  function watchCanvas() {
    canvas = document.querySelector("canvas[id]");
    if (!canvas) return;
    app = canvas.id.replace(/_canvas$/, "");
    label = document.title || app;
    if (window.MistySDK) canvas.setAttribute("data-host", "page");
    canvas.addEventListener(app + ":ready", function () {
      hostSeen = true;
      emit("host", { version: "1", handoff: false });
      if (pendingOpen) {
        var waiting = pendingOpen;
        pendingOpen = null;
        openBytes(waiting.name, waiting.data);
      }
    });
    canvas.addEventListener(app + ":save", onSave);
    canvas.addEventListener(app + ":dirty", function (event) {
      dirty = object(event.detail).dirty === true;
    });
  }

  window.addEventListener("TrunkApplicationStarted", function () {
    started = true;
    if (pendingOpen && !hostSeen) {
      var waiting = pendingOpen;
      pendingOpen = null;
      openBytes(waiting.name, waiting.data);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("readystatechange", function once() {
      if (document.readyState === "loading") return;
      document.removeEventListener("readystatechange", once);
      watchCanvas();
    });
  } else {
    watchCanvas();
  }

  var originalInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    var input = this;
    if (input.type !== "file" || !misty) return originalInputClick.apply(input, arguments);
    if (window.mistyScreen && window.mistyScreen.agentActing()) return originalInputClick.apply(input, arguments);
    var accept = (input.accept || "").split(",").map(function (kind) { return kind.trim(); }).filter(Boolean);
    misty.files
      .pick({ accept: accept, multiple: input.multiple })
      .then(function (refs) {
        if (!refs || refs.length === 0) {
          input.dispatchEvent(new Event("cancel", { bubbles: true }));
          return null;
        }
        return Promise.all(
          refs.map(function (ref) {
            return misty.files.download(ref.id).then(function (got) {
              if (!input.multiple) setCurrent(got.file);
              return new File([got.data], got.file.name, { type: got.file.mime });
            });
          }),
        );
      })
      .then(function (files) {
        if (!files) return;
        var transfer = new DataTransfer();
        files.forEach(function (file) { transfer.items.add(file); });
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(function () {
        input.dispatchEvent(new Event("cancel", { bubbles: true }));
      });
  };

  var originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var link = this;
    if (!misty || !link.hasAttribute("download") || !/^(blob|data):/.test(link.href)) {
      return originalAnchorClick.apply(link, arguments);
    }
    var name = link.getAttribute("download") || "download";
    fetch(link.href)
      .then(function (response) { return response.arrayBuffer(); })
      .then(function (data) { return saveToSpace(name, data, false); })
      .catch(function () { originalAnchorClick.call(link); });
  };

  function sdk() {
    return new Promise(function (resolve) {
      var check = function () {
        resolve(window.MistySDK && typeof window.MistySDK.connect === "function" ? window.MistySDK : null);
      };
      if (window.MistySDK || document.readyState !== "loading") check();
      else document.addEventListener("DOMContentLoaded", check, { once: true });
    });
  }

  sdk()
    .then(function (found) {
      if (!found) return null;
      return found.connect({ applyTheme: false }).catch(function () { return null; });
    })
    .then(function (found) {
      misty = found;
      connected.resolve();
      if (!misty) return;
      var fileId = object(misty.route().params).file;
      if (typeof fileId !== "string" || !fileId) return;
      return misty.files.download(fileId).then(function (got) {
        setCurrent(got.file);
        openBytes(got.file.name, got.data);
      });
    })
    .catch(function () {
      connected.resolve();
    });

  function api() {
    var page = app ? window[app] : null;
    return page && typeof page.request === "function" ? page : null;
  }

  function needApi() {
    var page = api();
    if (!page) throw new Error(label + " is still starting. Try again in a moment.");
    return page;
  }

  function toolList() {
    return [
      {
        name: "commands",
        description: "List " + label + "'s commands, each one's id, label and whether it is enabled now. Pass search to narrow the list and see each match's place in the menus, shortcut and the params it takes. Run one with execute.",
        inputSchema: {
          type: "object",
          properties: { search: { type: "string", description: "Words to narrow the list by, such as picture or align." } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "execute",
        description: "Run one of " + label + "'s commands in the open document, as its menus do: an id from commands and its params. A command that takes a file (a path or base64 data, such as insert.picture) takes it as file instead: a file in your working folder, which Misty hands to the app, so never put a file's data in params. Read the document with inspect_document before and after a change. Saving writes the file back into the Space.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command's id, from commands." },
            params: { type: "object", description: "The command's params, as commands lists them, without path or data." },
            file: { type: "string", format: "misty-file", description: "A file in your working folder, for a command that takes one." },
            files: {
              type: "array",
              items: { type: "string", format: "misty-file" },
              description: "Files in your working folder, for a command that takes several (such as insert.photoAlbum's pictures), in order.",
            },
            doc: { type: "number", description: "Which open document, from inspect_ui's documents; the active one when left out." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      {
        name: "inspect_document",
        description: "Read the open document in " + label + ": its contents, the selection and its parts. Pass text to look for where it appears.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to find in the document." },
            doc: { type: "number", description: "Which open document; the active one when left out." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "inspect_ui",
        description: "Read " + label + "'s own state: the open view and dialog, the window's size, the open documents with their ids and titles, whether they have unsaved changes, and which Space file is open.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  function base64Of(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var url = String(reader.result || "");
        resolve(url.slice(url.indexOf(",") + 1));
      };
      reader.onerror = function () { reject(reader.error || new Error("Misty couldn't read " + file.name + ".")); };
      reader.readAsDataURL(file);
    });
  }

  function isFile(value) {
    return typeof Blob === "function" && value instanceof Blob;
  }

  function withFiles(params, file, files) {
    var next = object(params);
    var copy = {};
    for (var key in next) copy[key] = next[key];
    var many = Array.isArray(files) ? files.filter(isFile) : [];
    var jobs = [];
    if (isFile(file)) {
      jobs.push(base64Of(file).then(function (data) {
        delete copy.path;
        copy.data = data;
        if (typeof copy.name !== "string" || !copy.name) copy.name = file.name;
      }));
    }
    if (many.length) {
      var pictures = Array.isArray(copy.pictures) ? copy.pictures.slice() : [];
      copy.pictures = pictures;
      many.forEach(function (one, index) {
        jobs.push(base64Of(one).then(function (data) {
          var entry = {};
          var given = object(pictures[index]);
          for (var key in given) entry[key] = given[key];
          delete entry.path;
          entry.data = data;
          if (typeof entry.name !== "string" || !entry.name) entry.name = one.name;
          pictures[index] = entry;
        }));
      });
    }
    return Promise.all(jobs).then(function () { return copy; });
  }

  function shortList(listed) {
    var rows = Array.isArray(listed) ? listed : listed && Array.isArray(listed.commands) ? listed.commands : null;
    if (!rows) return listed;
    var short = rows.map(function (row) {
      var item = object(row);
      return { id: item.id, label: item.label, enabled: item.enabled };
    });
    return Array.isArray(listed) ? short : Object.assign({}, listed, { commands: short });
  }

  function menuPath(page, command) {
    return Promise.resolve(page.request("engine.commands", { search: command }))
      .then(function (listed) {
        var rows = Array.isArray(listed) ? listed : listed && Array.isArray(listed.commands) ? listed.commands : [];
        var found = rows.filter(function (row) { return object(row).id === command; })[0];
        if (!found) return command;
        var label = String(found.label || command).replace(/[.…]+$/, "");
        return (Array.isArray(found.menu) ? found.menu : []).concat([label]).join(" › ");
      })
      .catch(function () { return command; });
  }

  function call(name, args, context) {
    var input = object(args);
    var page = needApi();
    var point = context && typeof context.point === "function" ? context.point : null;
    switch (name) {
      case "commands": {
        var search = typeof input.search === "string" && input.search ? input.search : "";
        var listed = page.request("engine.commands", search ? { search: search } : {});
        return search ? listed : Promise.resolve(listed).then(shortList);
      }
      case "execute": {
        if (typeof input.command !== "string" || !input.command) throw new Error("Name the command to run, from commands.");
        var shown = point
          ? menuPath(page, input.command).then(function (doing) { point(canvas, doing); })
          : Promise.resolve();
        return shown.then(function () {
          return withFiles(input.params, input.file, input.files);
        }).then(function (params) {
          var request = { command: input.command, params: params };
          if (typeof input.doc === "number") request.doc = input.doc;
          return page.request("engine.execute", request);
        });
      }
      case "inspect_document": {
        var query = {};
        if (typeof input.text === "string" && input.text) query.text = input.text;
        if (typeof input.doc === "number") query.doc = input.doc;
        return page.request("document.inspect", query);
      }
      case "inspect_ui":
        return page.request("ui.inspect", {}).then(function (state) {
          return { app: state, space_file: current ? { name: current.name, folder: current.folder || null } : null, unsaved: dirty };
        });
      default:
        throw new Error(label + " has no tool called " + name + ".");
    }
  }

  var registered = false;

  function offerTools() {
    var context = document.modelContext;
    if (registered || !api() || !context || typeof context.registerTool !== "function") return;
    registered = true;
    toolList().forEach(function (tool) {
      context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: function (input, options) { return call(tool.name, input, options); },
      }).catch(function () {});
    });
  }

  if (document.modelContext && typeof document.modelContext.registerTool === "function") {
    window.addEventListener("TrunkApplicationStarted", offerTools);
    if (canvas) canvas.addEventListener(app + ":ready", offerTools);
    else document.addEventListener("readystatechange", function () {
      if (canvas) canvas.addEventListener(app + ":ready", offerTools);
    });
    offerTools();
  } else {
    var adapter = { call: call };
    Object.defineProperty(adapter, "tools", {
      enumerable: true,
      get: function () { return api() ? toolList() : []; },
    });
    window.mistyAdapter = adapter;
  }
})();
