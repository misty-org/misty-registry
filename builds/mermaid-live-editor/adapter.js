(function () {
  "use strict";

  var TEXT = "text";
  var EXTENSION = ".mmd";
  var MIME = "text/vnd.mermaid";

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

  function textOf(data) {
    return new TextDecoder().decode(data).replace(/\r\n?/g, "\n");
  }

  var editorReady = deferred();
  var sdk = null;
  var misty = null;
  var opened = null;
  var room = null;
  var editor = null;
  var model = null;
  var monaco = null;
  var showing = false;

  function found() {
    var published = window.mistyMonaco;
    if (published && published.editor && published.mermaidModel) editorReady.resolve(published);
  }

  window.addEventListener("misty-monaco", found);
  found();

  function setModel(value) {
    if (model.getValue() === value) return;
    showing = true;
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], function () { return null; });
    } finally {
      showing = false;
    }
  }

  function connect() {
    return new Promise(function (resolve) {
      var check = function () {
        resolve(window.MistySDK && typeof window.MistySDK.connect === "function" ? window.MistySDK : null);
      };
      if (window.MistySDK || document.readyState !== "loading") check();
      else document.addEventListener("DOMContentLoaded", check, { once: true });
    }).then(function (module) {
      sdk = module;
      if (!module) return null;
      return module.connect({ applyTheme: false }).catch(function () { return null; });
    });
  }

  Promise.all([editorReady.promise, connect()]).then(function (results) {
    editor = results[0].editor;
    model = results[0].mermaidModel;
    monaco = results[0].monaco;
    misty = results[1];
    model.setEOL(0);
    if (!misty) return;
    model.onDidChangeContent(function () {
      if (!showing && opened) opened.changed();
    });
    opened = sdk.openDocument(misty, {
      extension: EXTENSION,
      mime: MIME,
      name: "Diagram",
      load: function (data, doc) {
        doc.getText(TEXT).insert(0, textOf(data));
      },
      serialize: function (doc) {
        return doc.getText(TEXT).toString();
      },
      current: function () {
        return model.getValue();
      },
      show: function (data) {
        setModel(textOf(data));
      },
      live: function (fileRoom) {
        room = fileRoom;
        sdk.bindMonacoModel(fileRoom, { editor: editor, model: model, monaco: monaco }, { text: fileRoom.doc.getText(TEXT) });
      },
    });
  }).catch(function () {});

  function needModel() {
    if (!model) throw new Error("The Mermaid editor is still starting. Try again in a moment.");
    return model;
  }

  function agentIn(context) {
    if (!room || !sdk || typeof sdk.agentOfCall !== "function") return null;
    var agent = sdk.agentOfCall(context);
    if (!agent) return null;
    return sdk.joinAsAgent(room, agent, {
      scope: function (mirror) { return mirror.getText(TEXT); },
    });
  }

  function markAt(agent, text, from, to) {
    var Y = sdk.Y;
    agent.setPresence({
      selection: {
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from)),
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to)),
      },
    });
  }

  function findOnce(value, piece) {
    var at = value.indexOf(piece);
    if (at < 0) throw new Error("The source doesn't contain that text. Read the diagram first.");
    if (value.indexOf(piece, at + 1) >= 0) throw new Error("That text appears more than once. Give a longer piece.");
    return at;
  }

  var tools = [
    {
      name: "read_diagram",
      description: "Read the open Mermaid diagram's source and which Space file it is. Everyone with the file open edits the same text live.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_diagram",
      description: "Replace the open diagram's Mermaid source. The preview redraws, and everyone with the file open sees it as your change.",
      inputSchema: {
        type: "object",
        properties: { source: { type: "string", description: "The whole diagram in Mermaid syntax." } },
        required: ["source"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "replace_text",
      description: "Replace one exact piece of the diagram's source with another, leaving the rest as it is, so edits others make at the same time are kept.",
      inputSchema: {
        type: "object",
        properties: {
          find: { type: "string", description: "Text that appears exactly once in the source." },
          replace: { type: "string" },
        },
        required: ["find", "replace"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "undo_my_change",
      description: "Take back your own last change to the diagram, leaving everyone else's as they are.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
  ];

  function call(name, args, context) {
    var input = object(args);
    var current = needModel();
    var agent = name === "read_diagram" ? null : agentIn(context);
    switch (name) {
      case "read_diagram":
        return {
          file: opened && opened.file ? opened.file.name : null,
          live: !!room,
          source: current.getValue(),
        };
      case "write_diagram": {
        if (typeof input.source !== "string") throw new Error("Give the whole diagram as source.");
        var source = input.source.replace(/\r\n?/g, "\n");
        if (agent) {
          agent.transact(function (mirror) {
            var text = mirror.getText(TEXT);
            text.delete(0, text.length);
            text.insert(0, source);
          });
          markAt(agent, agent.doc.getText(TEXT), 0, source.length);
          return { ok: true };
        }
        current.pushEditOperations([], [{ range: current.getFullModelRange(), text: source }], function () { return null; });
        return { ok: true };
      }
      case "replace_text": {
        if (typeof input.find !== "string" || !input.find || typeof input.replace !== "string") throw new Error("Give the text to find and what replaces it.");
        var replacement = input.replace.replace(/\r\n?/g, "\n");
        if (agent) {
          var mirrored = agent.doc.getText(TEXT);
          var spot = findOnce(mirrored.toString(), input.find);
          agent.transact(function (mirror) {
            var text = mirror.getText(TEXT);
            text.delete(spot, input.find.length);
            text.insert(spot, replacement);
          });
          markAt(agent, mirrored, spot, spot + replacement.length);
          return { ok: true };
        }
        var at = findOnce(current.getValue(), input.find);
        var start = current.getPositionAt(at);
        var end = current.getPositionAt(at + input.find.length);
        current.pushEditOperations([], [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: replacement }], function () { return null; });
        return { ok: true };
      }
      case "undo_my_change":
        if (!agent) throw new Error("Only a live diagram keeps each agent's own changes to undo.");
        return { undone: agent.undo() };
      default:
        throw new Error("The Mermaid editor has no tool called " + name + ".");
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
