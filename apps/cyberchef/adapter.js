(function () {
  "use strict";

  var MAX_READ = 20000;

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

  var appReady = deferred();
  var app = null;

  function isLoaded() {
    return !document.getElementById("loader-wrapper") || document.body.classList.contains("loaded");
  }

  window.addEventListener("load", function () {
    var found = window.app;
    if (!found || typeof found.getRecipeConfig !== "function") {
      appReady.reject(new Error("CyberChef didn't start."));
      return;
    }
    if (isLoaded()) {
      appReady.resolve(found);
      return;
    }
    var original = found.loaded;
    found.loaded = function () {
      var result = original.apply(this, arguments);
      if (isLoaded()) {
        found.loaded = original;
        appReady.resolve(found);
      }
      return result;
    };
  });

  function recipeText() {
    try {
      return JSON.stringify(app.getRecipeConfig() || []);
    } catch (error) {
      return "[]";
    }
  }

  function inputText() {
    try {
      return String(app.manager.input.getInput() || "");
    } catch (error) {
      return "";
    }
  }

  function outputText() {
    try {
      return app.manager.output.outputEditorView.state.doc.toString();
    } catch (error) {
      return "";
    }
  }

  appReady.promise.then(function (found) {
    app = found;
  });


  function needApp() {
    if (!app) throw new Error("CyberChef is still starting. Try again in a moment.");
    return app;
  }

  function clip(text) {
    return text.length > MAX_READ ? { text: text.slice(0, MAX_READ), length: text.length, cut: true } : { text: text, length: text.length };
  }

  function operations(search) {
    var all = object(needApp().operations);
    var words = typeof search === "string" ? search.toLowerCase().split(/\s+/).filter(Boolean) : [];
    return Object.keys(all)
      .filter(function (name) {
        if (!words.length) return true;
        var haystack = (name + " " + String(all[name].description || "")).toLowerCase();
        return words.every(function (word) { return haystack.indexOf(word) >= 0; });
      })
      .slice(0, 50)
      .map(function (name) {
        var op = object(all[name]);
        var text = new DOMParser().parseFromString(String(op.description || ""), "text/html");
        return {
          op: name,
          description: (text.body ? text.body.textContent : "").slice(0, 300),
          args: (Array.isArray(op.args) ? op.args : []).map(function (arg) {
            return { name: arg.name, type: arg.type, value: arg.value };
          }),
        };
      });
  }

  var tools = [
    {
      name: "read_kitchen",
      description: "Read CyberChef's kitchen: the recipe (its operations in order, each with its args), the input and the output, and whether it is baking now.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "find_operations",
      description: "Find CyberChef operations by words in their name or description (such as \"base64\", \"xor\" or \"gunzip\"), with the args each takes and their defaults. Use the op names and args in set_recipe.",
      inputSchema: {
        type: "object",
        properties: { search: { type: "string", description: "Words to look for." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "set_recipe",
      description: "Replace the recipe with these operations, in order: each is {\"op\": name, \"args\": [values in the order find_operations lists them]}. It bakes when auto bake is on; call bake otherwise, then read_kitchen for the output.",
      inputSchema: {
        type: "object",
        properties: {
          recipe: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string" },
                args: { type: "array" },
                disabled: { type: "boolean" },
                breakpoint: { type: "boolean" },
              },
              required: ["op"],
            },
          },
        },
        required: ["recipe"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "set_input",
      description: "Replace the input with this text. It bakes when auto bake is on.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "bake",
      description: "Run the recipe on the input now. The output shows in read_kitchen once it has baked.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
  ];

  function call(name, args) {
    var input = object(args);
    var current = needApp();
    switch (name) {
      case "read_kitchen":
        return {
          baking: !!current.baking,
          recipe: JSON.parse(recipeText()),
          input: clip(inputText()),
          output: clip(outputText()),
        };
      case "find_operations":
        return { operations: operations(input.search) };
      case "set_recipe": {
        if (!Array.isArray(input.recipe)) throw new Error("Give the recipe as a list of operations.");
        var known = object(current.operations);
        var recipe = input.recipe.map(function (step) {
          var op = object(step);
          if (typeof op.op !== "string" || !known[op.op]) throw new Error("CyberChef has no operation called " + op.op + ". Look it up with find_operations.");
          var defaults = (Array.isArray(known[op.op].args) ? known[op.op].args : []).map(function (arg) {
            return Array.isArray(arg.value) ? arg.value[0] : arg.value;
          });
          var out = { op: op.op, args: Array.isArray(op.args) ? op.args : defaults };
          if (op.disabled) out.disabled = true;
          if (op.breakpoint) out.breakpoint = true;
          return out;
        });
        current.setRecipeConfig(recipe);
        current.autoBake();
        return { ok: true };
      }
      case "set_input":
        if (typeof input.text !== "string") throw new Error("Give the input as text.");
        current.setInput(input.text);
        current.autoBake();
        return { ok: true };
      case "bake":
        current.bake();
        return { ok: true };
      default:
        throw new Error("CyberChef has no tool called " + name + ".");
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
