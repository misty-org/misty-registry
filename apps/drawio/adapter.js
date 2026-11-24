(function () {
  "use strict";

  var OPTIONS = {
    embed: "1",
    proto: "json",
    stealth: "1",
    pwa: "0",
    plugins: "0",
    noSaveBtn: "1",
    noExitBtn: "1",
    saveAndExit: "0",
    libraries: "1",
  };
  var CELLS = "drawio:cells";
  var PAGES = "drawio:pages";
  var FILE_META = "misty:file";
  var ORDER = "misty:order";
  var VIEW = "view:";
  var SEP = "\u001f";
  var LOCAL = { drawio: true };
  var MAX_SELECTION = 100;
  var POINTER_EVERY_MS = 80;
  var REPLY_WITHIN_MS = 60000;
  var TONES = {
    red: "#eab7ab",
    orange: "#f0c38e",
    yellow: "#f0d58c",
    green: "#c5cf8e",
    blue: "#a0c4d4",
    purple: "#d3b3c9",
    gray: "#d5c9b8",
  };
  var INK = "#3c3836";
  var REMOVED = { style: null, source: "", target: "", vertex: 0, edge: 0, connectable: 1, visible: 1, collapsed: 0 };
  var VERTEX_STYLE = "rounded=1;whiteSpace=wrap;html=1;";
  var EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";

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

  function same(left, right) {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    return JSON.stringify(left) === JSON.stringify(right);
  }

  (function setOptions() {
    try {
      var params = new URLSearchParams(window.location.search);
      var changed = params.has("dev");
      params.delete("dev");
      Object.keys(OPTIONS).forEach(function (key) {
        if (params.get(key) !== OPTIONS[key]) {
          params.set(key, OPTIONS[key]);
          changed = true;
        }
      });
      if (changed) {
        history.replaceState(history.state, "", window.location.pathname + "?" + params.toString() + window.location.hash);
      }
    } catch (error) {
      return;
    }
    try {
      window.DRAWIO_SERVER_URL = new URL("./", window.location.href).href;
    } catch (error) {
      return;
    }
  })();

  var editor = deferred();
  var drawioReady = deferred();
  var hooked = false;

  var port = {
    postMessage: function (data) {
      Promise.resolve().then(function () {
        fromDrawio(data);
      });
    },
  };

  function adopt(ui) {
    ui.embedMessageSource = port;
    ui.onBeforeUnload = function () {
      return null;
    };
    editor.resolve(ui);
  }

  function hook() {
    if (hooked || typeof window.App !== "function" || typeof window.App.initPluginCallback !== "function") return;
    hooked = true;
    window.App.initPluginCallback();
    window.App.embedModePluginsCount++;
    window.Draw.loadPlugin(adopt);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var original = window.checkAllLoaded;
    if (typeof original !== "function") return;
    window.checkAllLoaded = function () {
      if (window.mxScriptsLoaded && window.mxWinLoaded) hook();
      return original.apply(this, arguments);
    };
  });
  window.addEventListener("load", hook);

  var nextRequest = 1;
  var replies = new Map();
  var loads = [];

  function toDrawio(message) {
    var event = new MessageEvent("message", { data: JSON.stringify(message) });
    Object.defineProperty(event, "source", { value: port });
    window.dispatchEvent(event);
  }

  function within(parts, what) {
    var timer = setTimeout(function () {
      parts.reject(new Error("draw.io didn't finish " + what + "."));
    }, REPLY_WITHIN_MS);
    return parts.promise.then(
      function (value) {
        clearTimeout(timer);
        return value;
      },
      function (error) {
        clearTimeout(timer);
        throw error;
      },
    );
  }

  function ask(action, fields) {
    var id = nextRequest++;
    var parts = deferred();
    replies.set(id, parts);
    var message = Object.assign({}, fields, { action: action, mistyRequest: id });
    Promise.resolve().then(function () {
      toDrawio(message);
    });
    return within(parts, action === "export" ? "the export" : action).finally(function () {
      replies.delete(id);
    });
  }

  function loadDrawio(xml) {
    var parts = deferred();
    loads.push(parts);
    Promise.resolve().then(function () {
      toDrawio({ action: "load", xml: xml || "", autosave: 0, noExitBtn: 1, saveAndExit: 0 });
    });
    return within(parts, "opening the diagram");
  }

  function fromDrawio(data) {
    var message;
    try {
      message = typeof data === "string" ? JSON.parse(data) : data;
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.event === "init") {
      drawioReady.resolve();
      return;
    }
    if (message.event === "load") {
      var waiting = loads.shift();
      if (!waiting) return;
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message);
      return;
    }
    var request = message.message && message.message.mistyRequest;
    var reply = typeof request === "number" ? replies.get(request) : null;
    if (!reply) return;
    if (message.error) reply.reject(new Error(String(message.error)));
    else reply.resolve(message);
  }

  var ui = null;
  var misty = null;
  var room = null;
  var doc = null;
  var cells = null;
  var pages = null;
  var YMap = null;
  var shown = false;
  var bound = false;
  var applying = null;
  var flushing = false;
  var flushQueued = false;
  var pagesRemote = false;
  var dirty = new Map();
  var pageCells = new Map();
  var parentOf = new Map();
  var kids = new Map();
  var onLocalChange = null;
  var shownParts = deferred();
  var fileName = "";
  var fileFolder;

  function keyOf(pageId, cellId) {
    return pageId + SEP + cellId;
  }

  function split(key) {
    var at = typeof key === "string" ? key.indexOf(SEP) : -1;
    return at < 0 ? null : { page: key.slice(0, at), id: key.slice(at + 1) };
  }

  function isMap(value) {
    return value != null && typeof value.get === "function" && typeof value.set === "function";
  }

  function reindex(key) {
    var part = split(key);
    if (!part) return;
    var old = parentOf.get(key);
    if (old !== undefined) {
      var before = kids.get(keyOf(part.page, old));
      if (before) {
        before.delete(part.id);
        if (!before.size) kids.delete(keyOf(part.page, old));
      }
      parentOf.delete(key);
    }
    var entry = cells.get(key);
    var inPage = pageCells.get(part.page);
    if (!isMap(entry)) {
      if (inPage) {
        inPage.delete(part.id);
        if (!inPage.size) pageCells.delete(part.page);
      }
      return;
    }
    if (!inPage) pageCells.set(part.page, (inPage = new Set()));
    inPage.add(part.id);
    var parent = entry.get("parent");
    parent = typeof parent === "string" ? parent : "";
    parentOf.set(key, parent);
    var siblings = kids.get(keyOf(part.page, parent));
    if (!siblings) kids.set(keyOf(part.page, parent), (siblings = new Set()));
    siblings.add(part.id);
  }

  function orderIn(pageId, id) {
    var entry = cells.get(keyOf(pageId, id));
    var order = isMap(entry) ? entry.get(ORDER) : null;
    return typeof order === "number" && isFinite(order) ? order : 0;
  }

  function roomChildren(pageId, parentId) {
    var set = kids.get(keyOf(pageId, parentId));
    if (!set) return [];
    return Array.from(set).sort(function (left, right) {
      return orderIn(pageId, left) - orderIn(pageId, right) || (left < right ? -1 : left > right ? 1 : 0);
    });
  }

  function roomPageIds() {
    var ids = [];
    pages.forEach(function (entry, id) {
      if (isMap(entry)) ids.push(id);
    });
    var orderOf = function (id) {
      var order = pages.get(id).get("order");
      return typeof order === "number" && isFinite(order) ? order : 0;
    };
    return ids.sort(function (left, right) {
      return orderOf(left) - orderOf(right) || (left < right ? -1 : left > right ? 1 : 0);
    });
  }

  function fieldsOf(entry) {
    var fields = entry.toJSON();
    delete fields[ORDER];
    return fields;
  }

  function cellJson(cell) {
    var json = ui.getJsonForCell(cell);
    delete json.id;
    delete json.previous;
    Object.keys(json).forEach(function (key) {
      if (json[key] === undefined || typeof json[key] === "function") delete json[key];
    });
    return json;
  }

  function walk(cell, visit) {
    visit(cell);
    var count = cell.getChildCount();
    for (var index = 0; index < count; index++) walk(cell.getChildAt(index), visit);
  }

  function currentPage() {
    return ui.currentPage;
  }

  function pageIdOf(page) {
    return page ? page.getId() : "page";
  }

  function rootOf(page) {
    if (!page || page === ui.currentPage) return ui.editor.graph.model.getRoot();
    if (page.root == null) ui.updatePageRoot(page);
    return page.root;
  }

  function viewOf(page) {
    var state = !page || page === ui.currentPage ? ui.editor.graph.getViewState() : page.viewState;
    if (state == null && page) {
      ui.updatePageRoot(page);
      state = page.viewState;
    }
    var result = {};
    if (state == null) return result;
    Object.keys(ui.viewStateProperties || {}).forEach(function (key) {
      var json = JSON.stringify(ui.getViewStateProperty(state, key));
      if (json !== undefined) result[key] = json;
    });
    return result;
  }

  function writeFields(key, json) {
    var entry = cells.get(key);
    if (!isMap(entry)) {
      entry = new YMap();
      cells.set(key, entry);
    }
    Object.keys(json).forEach(function (name) {
      if (!same(entry.get(name), json[name])) entry.set(name, json[name]);
    });
    Array.from(entry.keys()).forEach(function (name) {
      if (name !== ORDER && !(name in json)) entry.delete(name);
    });
    return entry;
  }

  function spread(low, high, step, count) {
    if (low === null && high === null) return step + 1;
    if (low === null) return high - (count - step);
    if (high === null) return low + step + 1;
    return low + ((high - low) * (step + 1)) / (count + 1);
  }

  function placeChildren(pageId, children, changed) {
    var entries = children.map(function (child) {
      return child.id == null ? null : cells.get(keyOf(pageId, child.id));
    });
    var orders = entries.map(function (entry) {
      var order = isMap(entry) ? entry.get(ORDER) : null;
      return typeof order === "number" && isFinite(order) ? order : null;
    });
    var moving = function (index) {
      return !changed || changed.has(children[index]);
    };
    var nextSteady = function (index) {
      for (var next = index + 1; next < children.length; next++) {
        if (!moving(next) && orders[next] !== null) return orders[next];
      }
      return Infinity;
    };
    var anchored = [];
    var last = -Infinity;
    for (var index = 0; index < children.length; index++) {
      var order = orders[index];
      var fits = isMap(entries[index]) && order !== null && order > last && (!moving(index) || order < nextSteady(index));
      anchored[index] = fits;
      if (fits) last = order;
    }
    var placed = orders.slice();
    var crowded = false;
    var at = 0;
    while (at < children.length) {
      if (anchored[at]) {
        at++;
        continue;
      }
      var start = at;
      while (at < children.length && !anchored[at]) at++;
      var low = start > 0 ? placed[start - 1] : null;
      var high = at < children.length ? placed[at] : null;
      var count = at - start;
      for (var step = 0; step < count; step++) {
        var value = spread(low, high, step, count);
        var floor = step > 0 ? placed[start + step - 1] : low;
        if (!(floor === null || value > floor) || !(high === null || value < high) || !isFinite(value)) crowded = true;
        placed[start + step] = value;
      }
    }
    if (crowded) placed = children.map(function (_, index) { return index + 1; });
    entries.forEach(function (entry, index) {
      if (isMap(entry) && entry.get(ORDER) !== placed[index]) entry.set(ORDER, placed[index]);
    });
  }

  function syncPageMeta(page) {
    var id = pageIdOf(page);
    var entry = pages.get(id);
    if (!isMap(entry)) {
      entry = new YMap();
      pages.set(id, entry);
    }
    var name = page ? page.getName() : null;
    if (typeof name === "string" && entry.get("name") !== name) entry.set("name", name);
    var view = viewOf(page);
    Object.keys(view).forEach(function (key) {
      if (entry.get(VIEW + key) !== view[key]) entry.set(VIEW + key, view[key]);
    });
  }

  function syncPageCells(page) {
    var pageId = pageIdOf(page);
    var root = rootOf(page);
    if (!root) return;
    var present = new Set();
    walk(root, function (cell) {
      if (cell.id == null) return;
      present.add(String(cell.id));
      writeFields(keyOf(pageId, cell.id), cellJson(cell));
      if (cell.getChildCount() > 0) placeChildren(pageId, cell.children, null);
    });
    var known = pageCells.get(pageId);
    if (known) {
      Array.from(known).forEach(function (id) {
        if (!present.has(id)) cells.delete(keyOf(pageId, id));
      });
    }
  }

  function syncPageOrder(list) {
    var room = roomPageIds();
    var ids = list.map(pageIdOf);
    if (ids.length === room.length && ids.every(function (id, index) { return id === room[index]; })) return;
    ids.forEach(function (id, index) {
      var entry = pages.get(id);
      if (isMap(entry) && entry.get("order") !== index + 1) entry.set("order", index + 1);
    });
  }

  function syncAll() {
    var list = ui.pages && ui.pages.length ? ui.pages : [ui.currentPage];
    var ids = new Set();
    list.forEach(function (page) {
      ids.add(pageIdOf(page));
      syncPageMeta(page);
      syncPageCells(page);
    });
    Array.from(pages.keys()).forEach(function (id) {
      if (ids.has(id)) return;
      pages.delete(id);
      var known = pageCells.get(id);
      if (known) Array.from(known).forEach(function (cellId) { cells.delete(keyOf(id, cellId)); });
    });
    syncPageOrder(list);
  }

  function syncCell(pageId, cell, parents) {
    if (cell.id == null) return;
    var model = ui.editor.graph.model;
    var key = keyOf(pageId, cell.id);
    var found = model.getCell(cell.id);
    if (found !== cell) {
      if (found == null && cells.has(key)) cells.delete(key);
      return;
    }
    writeFields(key, cellJson(cell));
    if (parents && cell.parent) parents.add(cell.parent);
  }

  function mark(set, cell, deep) {
    if (!cell) return;
    set.add(cell);
    if (!deep) return;
    var count = cell.getChildCount();
    for (var index = 0; index < count; index++) mark(set, cell.getChildAt(index), true);
  }

  function onModelChange(sender, event) {
    var edit = event.getProperty("edit");
    var changes = edit && edit.changes ? edit.changes : [];
    var marked = new Set();
    var whole = false;
    var pagesChanged = false;
    changes.forEach(function (change) {
      if (typeof window.SelectPage === "function" && change instanceof window.SelectPage) return;
      if (typeof window.mxCurrentRootChange === "function" && change instanceof window.mxCurrentRootChange) return;
      if (change instanceof window.mxChildChange) mark(marked, change.child, true);
      else if (change instanceof window.mxRootChange) whole = true;
      else if (change && change.cell instanceof window.mxCell) mark(marked, change.cell, false);
      else if (change) pagesChanged = true;
    });
    if (applying) {
      marked.forEach(function (cell) { applying.add(cell); });
      return;
    }
    if (!marked.size && !whole && !pagesChanged) return;
    if (onLocalChange) onLocalChange();
    if (!bound) return;
    doc.transact(function () {
      if (pagesChanged) {
        syncAll();
        return;
      }
      var page = currentPage();
      if (whole) {
        syncPageMeta(page);
        syncPageCells(page);
        return;
      }
      var pageId = pageIdOf(page);
      var parents = new Set();
      marked.forEach(function (cell) { syncCell(pageId, cell, parents); });
      parents.forEach(function (parent) {
        if (ui.editor.graph.model.getCell(parent.id) === parent) placeChildren(pageId, parent.children || [], marked);
      });
    }, LOCAL);
    ui.editor.setModified(false);
  }

  function touched(key, remote) {
    reindex(key);
    if (!remote) return;
    var part = split(key);
    if (!part) return;
    var set = dirty.get(part.page);
    if (!set) dirty.set(part.page, (set = new Set()));
    set.add(part.id);
  }

  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    Promise.resolve().then(function () {
      flushQueued = false;
      flushRemote();
    });
  }

  function watchRoom() {
    doc = room.doc;
    cells = doc.getMap(CELLS);
    pages = doc.getMap(PAGES);
    YMap = cells.constructor;
    cells.forEach(function (entry, key) { reindex(key); });
    cells.observeDeep(function (events, transaction) {
      var remote = transaction.origin !== LOCAL;
      events.forEach(function (event) {
        if (event.target === cells) event.keysChanged.forEach(function (key) { touched(key, remote); });
        else if (event.path.length) touched(event.path[0], remote);
      });
      if (remote) queueFlush();
    });
    pages.observeDeep(function (events, transaction) {
      if (transaction.origin === LOCAL) return;
      pagesRemote = true;
      queueFlush();
    });
  }

  function buildRoot(pageId, xmlDoc) {
    var made = new Map();
    var parents = new Map();
    var ids = pageCells.get(pageId) ? Array.from(pageCells.get(pageId)) : [];
    ids.forEach(function (id) {
      var entry = cells.get(keyOf(pageId, id));
      if (!isMap(entry)) return;
      var json = fieldsOf(entry);
      json.id = id;
      var cell = ui.getCellForJson(json);
      made.set(id, cell);
      parents.set(id, typeof json.parent === "string" ? json.parent : "");
      cell.mistySource = json.source;
      cell.mistyTarget = json.target;
    });
    var roots = [];
    made.forEach(function (cell, id) {
      var parentId = parents.get(id);
      if (!parentId) roots.push(cell);
    });
    var root = made.get("0") && !parents.get("0") ? made.get("0") : roots[0];
    if (!root) {
      root = new window.mxCell();
      root.id = "0";
      var layer = new window.mxCell();
      layer.id = "1";
      root.insert(layer);
    }
    var placed = new Set([String(root.id)]);
    var attach = function (parentId) {
      var parent = made.get(parentId) || (parentId === root.id ? root : null);
      if (!parent) return;
      roomChildren(pageId, parentId).forEach(function (id) {
        var child = made.get(id);
        if (!child || placed.has(id)) return;
        placed.add(id);
        parent.insert(child);
        attach(id);
      });
    };
    attach(root.id);
    made.forEach(function (cell) {
      if (cell.mistySource && made.get(cell.mistySource)) cell.setTerminal(made.get(cell.mistySource), true);
      if (cell.mistyTarget && made.get(cell.mistyTarget)) cell.setTerminal(made.get(cell.mistyTarget), false);
      delete cell.mistySource;
      delete cell.mistyTarget;
    });
    var model = new window.mxGraphModel(root);
    return new window.mxCodec(xmlDoc).encode(model);
  }

  function pageNode(pageId, xmlDoc) {
    var entry = pages.get(pageId);
    var diagram = xmlDoc.createElement("diagram");
    diagram.setAttribute("id", pageId);
    var name = isMap(entry) ? entry.get("name") : null;
    if (typeof name === "string") diagram.setAttribute("name", name);
    var node = buildRoot(pageId, xmlDoc);
    var graph = ui.editor.graph;
    var state = graph.createViewState(xmlDoc.createElement("mxGraphModel"));
    if (isMap(entry)) {
      entry.forEach(function (value, key) {
        if (typeof value !== "string" || key.indexOf(VIEW) !== 0) return;
        try {
          state[key.slice(VIEW.length)] = JSON.parse(value);
        } catch (error) {
          return;
        }
      });
    }
    graph.saveViewState(state, node);
    diagram.appendChild(node);
    return diagram;
  }

  function roomXml() {
    var ids = roomPageIds();
    if (!ids.length) return "";
    var xmlDoc = window.mxUtils.createXmlDocument();
    var file = xmlDoc.createElement("mxfile");
    xmlDoc.appendChild(file);
    ids.forEach(function (id) { file.appendChild(pageNode(id, xmlDoc)); });
    return window.mxUtils.getXml(file);
  }

  function finder(page) {
    if (page === ui.currentPage) {
      var model = ui.editor.graph.model;
      return function (id) { return model.getCell(id); };
    }
    var lookup = new Map();
    var root = rootOf(page);
    if (root) walk(root, function (cell) { if (cell.id != null) lookup.set(String(cell.id), cell); });
    return function (id) { return lookup.get(id); };
  }

  function prevSiblingId(cell) {
    var parent = cell.parent;
    if (!parent) return "";
    var index = parent.getIndex(cell);
    return index > 0 ? String(parent.getChildAt(index - 1).id) : "";
  }

  function cellDiff(have, want) {
    var diff = {};
    var names = new Set(Object.keys(have).concat(Object.keys(want)));
    names.forEach(function (name) {
      if (name === "parent" || name === "value" || name === "xmlValue") return;
      if (same(have[name], want[name])) return;
      if (want[name] !== undefined) diff[name] = want[name];
      else if (name in REMOVED) diff[name] = REMOVED[name];
      else if (name !== "geometry") diff[name] = null;
    });
    if (want.xmlValue !== undefined) {
      if (!same(have.xmlValue, want.xmlValue)) diff.xmlValue = want.xmlValue;
    } else if (have.xmlValue !== undefined || !same(have.value, want.value)) {
      diff.value = want.value !== undefined ? want.value : null;
    }
    return diff;
  }

  function cellsPatch(page, ids) {
    var pageId = pageIdOf(page);
    var find = finder(page);
    var sorted = new Map();
    var previousOf = function (id, parentId) {
      if (!sorted.has(parentId)) sorted.set(parentId, roomChildren(pageId, parentId));
      var list = sorted.get(parentId);
      var index = list.indexOf(id);
      return index > 0 ? list[index - 1] : "";
    };
    var inserts = [];
    var removes = [];
    var updates = {};
    ids.forEach(function (id) {
      var entry = cells.get(keyOf(pageId, id));
      var cell = find(id);
      if (!isMap(entry)) {
        if (cell && cell.parent) removes.push(id);
        return;
      }
      var want = fieldsOf(entry);
      var parentId = typeof want.parent === "string" ? want.parent : "";
      if (!cell) {
        if (!parentId) return;
        var json = Object.assign({}, want, { id: id, previous: previousOf(id, parentId) });
        inserts.push(json);
        return;
      }
      var diff = cellDiff(cellJson(cell), want);
      var actualParent = cell.parent ? String(cell.parent.id) : "";
      if (parentId && actualParent !== parentId) diff.parent = parentId;
      if (parentId) {
        var previous = previousOf(id, parentId);
        if (diff.parent !== undefined || prevSiblingId(cell) !== previous) diff.previous = previous;
      }
      if (Object.keys(diff).length) updates[id] = diff;
    });
    var result = {};
    if (inserts.length) result[window.EditorUi.DIFF_INSERT] = inserts;
    if (removes.length) result[window.EditorUi.DIFF_REMOVE] = removes;
    if (Object.keys(updates).length) result[window.EditorUi.DIFF_UPDATE] = updates;
    return Object.keys(result).length ? result : null;
  }

  function pageUpdate(page) {
    var entry = pages.get(pageIdOf(page));
    var update = {};
    var name = entry.get("name");
    if (typeof name === "string" && name !== page.getName()) update.name = name;
    var view = viewOf(page);
    var changed = {};
    entry.forEach(function (value, key) {
      if (typeof value !== "string" || key.indexOf(VIEW) !== 0) return;
      var property = key.slice(VIEW.length);
      if (view[property] !== value) changed[property] = value;
    });
    if (Object.keys(changed).length) update.view = changed;
    return update;
  }

  function buildPatch() {
    var DIFF_INSERT = window.EditorUi.DIFF_INSERT;
    var DIFF_REMOVE = window.EditorUi.DIFF_REMOVE;
    var DIFF_UPDATE = window.EditorUi.DIFF_UPDATE;
    var list = ui.pages || [];
    var local = new Map();
    list.forEach(function (page) { local.set(pageIdOf(page), page); });
    var updates = {};
    var inserts = [];
    var removes = [];
    var skip = new Set();
    if (pagesRemote) {
      pagesRemote = false;
      var order = roomPageIds();
      var inRoom = new Set(order);
      list.forEach(function (page) {
        if (inRoom.has(pageIdOf(page))) return;
        removes.push(pageIdOf(page));
        skip.add(pageIdOf(page));
      });
      if (order.length) {
        var remaining = list.map(pageIdOf).filter(function (id) { return !skip.has(id); });
        var xmlDoc = window.mxUtils.createXmlDocument();
        var previous = "";
        order.forEach(function (id) {
          var page = local.get(id);
          if (!page) {
            inserts.push({ id: id, data: window.mxUtils.getXml(pageNode(id, xmlDoc)), previous: previous });
            skip.add(id);
          } else {
            var update = pageUpdate(page);
            var at = remaining.indexOf(id);
            if ((at > 0 ? remaining[at - 1] : "") !== previous) update.previous = previous;
            if (Object.keys(update).length) updates[id] = update;
          }
          previous = id;
        });
      } else {
        removes.length = 0;
      }
    }
    dirty.forEach(function (ids, pageId) {
      var page = local.get(pageId);
      if (!page || skip.has(pageId)) return;
      var diff = cellsPatch(page, ids);
      if (!diff) return;
      if (!updates[pageId]) updates[pageId] = {};
      updates[pageId].cells = diff;
    });
    dirty.clear();
    var patch = {};
    if (inserts.length) patch[DIFF_INSERT] = inserts;
    if (removes.length) patch[DIFF_REMOVE] = removes;
    if (Object.keys(updates).length) patch[DIFF_UPDATE] = updates;
    return Object.keys(patch).length ? patch : null;
  }

  function flushRemote() {
    if (!bound || flushing) return;
    var patch = buildPatch();
    if (!patch) return;
    var file = ui.getCurrentFile();
    if (!file || typeof file.patch !== "function") return;
    flushing = true;
    var changed = (applying = new Set());
    try {
      file.patch([patch], null, false, false, true);
    } finally {
      applying = null;
      flushing = false;
    }
    ui.editor.setModified(false);
    if (changed.size) {
      var pageId = pageIdOf(currentPage());
      doc.transact(function () {
        changed.forEach(function (cell) { syncCell(pageId, cell, null); });
      }, LOCAL);
    }
    paintSoon();
    if (dirty.size || pagesRemote) queueFlush();
  }

  function bind() {
    if (bound) return;
    bound = true;
    onLocalChange = null;
    ui.editor.setModified(false);
    publishPresence();
    flushRemote();
  }

  function writeAll() {
    doc.transact(syncAll, LOCAL);
    ui.editor.setModified(false);
  }

  function diagramXml(text) {
    var trimmed = (text || "").trim();
    if (!trimmed) return "";
    if (trimmed.charAt(0) === "<") {
      var node = window.mxUtils.parseXml(trimmed).documentElement;
      if (node && node.nodeName.toLowerCase() === "svg") {
        var model = ui.editor.extractGraphModel(node, true);
        return model ? window.mxUtils.getXml(model) : "";
      }
    }
    return trimmed;
  }

  function show(xml) {
    return loadDrawio(xml).then(function () {
      shown = true;
      ui.editor.setModified(false);
      shownParts.resolve();
    });
  }

  function serialize() {
    return shownParts.promise.then(function () {
      if (dirty.size || pagesRemote) flushRemote();
      return /\.svg$/i.test(fileName) ? ui.getFileData(false, true) : ui.getFileData(true);
    });
  }

  function loadFromFile(data) {
    return drawioReady.promise.then(function () {
      if (shown) {
        writeAll();
        bind();
        return;
      }
      var text = new TextDecoder().decode(data);
      return show(diagramXml(text)).then(function () {
        writeAll();
        bind();
      });
    });
  }

  function showRoom() {
    if (shown) {
      bind();
      return Promise.resolve();
    }
    return show(roomXml()).then(bind);
  }

  var opened = null;

  function fileData() {
    return /\.svg$/i.test(fileName) ? ui.getFileData(false, true) : ui.getFileData(true);
  }

  function openWithKit(module) {
    opened = module.openDocument(misty, {
      extension: ".drawio",
      mime: "application/vnd.jgraph.mxfile",
      name: "Diagram",
      load: loadFromFile,
      serialize: serialize,
      current: fileData,
      show: function (data) {
        return show(diagramXml(new TextDecoder().decode(data)));
      },
      opening: function (fileRoom) {
        room = fileRoom;
        watchRoom();
        watchPresence();
        room.onLost(function (error) {
          bound = false;
          if (ui) ui.handleError({ message: "This diagram stopped being live: " + error.message });
        });
      },
      live: showRoom,
    });
    opened.onFile(function (file) {
      fileName = file.name || fileName;
      fileFolder = file.folder;
    });
    onLocalChange = function () {
      if (opened) opened.changed();
    };
    return opened.ready;
  }

  var others = new Map();
  var pointer = null;
  var pointerTimer = 0;
  var paintQueued = false;

  function toneColor(tone) {
    var tokens = misty && misty.theme ? object(misty.theme().tokens) : {};
    var key = tone && TONES[tone] ? tone : "gray";
    return tokens["--color-avatar-" + key] || TONES[key];
  }

  function inkColor() {
    var tokens = misty && misty.theme ? object(misty.theme().tokens) : {};
    return tokens["--color-avatar-ink"] || INK;
  }

  function cursorFor(name, color) {
    var cursor = document.createElement("div");
    cursor.style.cssText =
      "position:absolute;left:0;top:0;pointer-events:none;display:none;z-index:3;transition:transform 90ms linear;";
    var ns = "http://www.w3.org/2000/svg";
    var arrow = document.createElementNS(ns, "svg");
    arrow.setAttribute("width", "14");
    arrow.setAttribute("height", "18");
    arrow.setAttribute("viewBox", "0 0 14 18");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M1 1 L1 15 L5 11.5 L8 17 L10.5 16 L7.5 10.5 L13 10.5 Z");
    path.setAttribute("fill", color);
    path.setAttribute("stroke", inkColor());
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linejoin", "round");
    arrow.appendChild(path);
    cursor.appendChild(arrow);
    var label = document.createElement("div");
    label.textContent = name;
    label.style.cssText =
      "margin:-2px 0 0 12px;padding:2px 6px;border-radius:4px;font:12px/16px Inter,system-ui,sans-serif;" +
      "white-space:nowrap;max-width:180px;overflow:hidden;background:" + color + ";color:" + inkColor() + ";";
    cursor.appendChild(label);
    return cursor;
  }

  function clearOther(view) {
    view.highlights.forEach(function (highlight) { highlight.destroy(); });
    view.highlights = [];
  }

  function dropOther(clientId) {
    var view = others.get(clientId);
    if (!view) return;
    clearOther(view);
    if (view.cursor.parentNode) view.cursor.parentNode.removeChild(view.cursor);
    others.delete(clientId);
  }

  function paintPresence() {
    paintQueued = false;
    if (!room || !ui || !shown) return;
    var graph = ui.editor.graph;
    var model = graph.model;
    var here = pageIdOf(currentPage());
    var states = room.awareness.getStates();
    Array.from(others.keys()).forEach(function (clientId) {
      if (!states.has(clientId)) dropOther(clientId);
    });
    var known = new Map();
    if (window.MistySDK && typeof window.MistySDK.peersOf === "function") {
      window.MistySDK.peersOf(room).forEach(function (peer) { known.set(peer.clientId, peer); });
    }
    states.forEach(function (state, clientId) {
      if (clientId === doc.clientID) return;
      var who = known.get(clientId) || room.identity(clientId);
      if (!who) {
        dropOther(clientId);
        return;
      }
      var color = toneColor(who.tone);
      var view = others.get(clientId);
      if (view && (view.name !== who.name || view.color !== color)) {
        dropOther(clientId);
        view = null;
      }
      if (!view) {
        view = { name: who.name, color: color, cursor: cursorFor(who.name, color), highlights: [] };
        others.set(clientId, view);
      }
      var container = ui.diagramContainer || graph.container;
      if (view.cursor.parentNode !== container) container.appendChild(view.cursor);
      var drawio = object(state && (state.drawio || (state.presence && state.presence.drawio)));
      var onPage = drawio.page === here;
      var at = object(drawio.pointer);
      if (onPage && typeof at.x === "number" && typeof at.y === "number") {
        var translate = graph.view.translate;
        var scale = graph.view.scale;
        view.cursor.style.transform =
          "translate(" + Math.round((translate.x + at.x) * scale) + "px," + Math.round((translate.y + at.y) * scale) + "px)";
        view.cursor.style.display = "";
      } else {
        view.cursor.style.display = "none";
      }
      clearOther(view);
      if (!onPage || !Array.isArray(drawio.selection)) return;
      drawio.selection.slice(0, MAX_SELECTION).forEach(function (id) {
        if (typeof id !== "string") return;
        var cell = model.getCell(id);
        var cellState = cell ? graph.view.getState(cell) : null;
        if (!cellState) return;
        var highlight = new window.mxCellHighlight(graph, color, 3, false);
        highlight.opacity = 80;
        highlight.highlight(cellState);
        view.highlights.push(highlight);
      });
    });
  }

  function paintSoon() {
    if (paintQueued) return;
    paintQueued = true;
    Promise.resolve().then(paintPresence);
  }

  function publishPresence() {
    pointerTimer = 0;
    if (!room || !ui || !shown) return;
    var graph = ui.editor.graph;
    var selection = graph.getSelectionCells().slice(0, MAX_SELECTION).map(function (cell) { return String(cell.id); });
    room.awareness.setLocalStateField("drawio", {
      page: pageIdOf(currentPage()),
      pointer: pointer,
      selection: selection,
    });
  }

  function publishSoon() {
    if (pointerTimer) return;
    pointerTimer = setTimeout(publishPresence, POINTER_EVERY_MS);
  }

  function watchPresence() {
    room.awareness.on("change", paintSoon);
    editor.promise.then(function () {
      var graph = ui.editor.graph;
      var pointOf = function (mouse) {
        var offset = window.mxUtils.getOffset(graph.container);
        var translate = graph.view.translate;
        var scale = graph.view.scale;
        return {
          x: Math.round((mouse.getX() - offset.x + graph.container.scrollLeft) / scale - translate.x),
          y: Math.round((mouse.getY() - offset.y + graph.container.scrollTop) / scale - translate.y),
        };
      };
      graph.addMouseListener({
        mouseDown: function () {},
        mouseMove: function (sender, mouse) {
          pointer = pointOf(mouse);
          publishSoon();
        },
        mouseUp: function (sender, mouse) {
          pointer = pointOf(mouse);
          publishSoon();
        },
      });
      graph.container.addEventListener("pointerleave", function () {
        pointer = null;
        publishSoon();
      });
      graph.getSelectionModel().addListener(window.mxEvent.CHANGE, publishSoon);
      ui.editor.addListener("pageSelected", function () {
        publishPresence();
        paintSoon();
      });
      [window.mxEvent.SCALE, window.mxEvent.TRANSLATE, window.mxEvent.SCALE_AND_TRANSLATE].forEach(function (name) {
        graph.view.addListener(name, paintSoon);
      });
      graph.model.addListener(window.mxEvent.CHANGE, paintSoon);
    });
  }

  function followTheme() {
    var apply = function (theme) {
      if (ui && typeof ui.setDarkMode === "function" && theme && (theme.mode === "dark" || theme.mode === "light")) {
        ui.setDarkMode(theme.mode === "dark");
      }
    };
    apply(misty.theme());
    misty.onTheme(apply);
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
    Promise.all([editor.promise, drawioReady.promise, connected])
      .then(function (results) {
        ui = results[0];
        misty = results[2];
        ui.editor.graph.model.addListener(window.mxEvent.CHANGE, onModelChange);
        if (!misty) return show("");
        followTheme();
        var fileId = object(misty.route().params).file;
        var blank = typeof fileId !== "string" || !fileId ? show("") : Promise.resolve();
        return blank.then(function () { return openWithKit(module); });
      })
      .catch(function (error) {
        if (ui) ui.handleError({ message: "The diagram couldn't be opened: " + (error && error.message ? error.message : error) });
      });
    editor.promise.then(function (found) { ui = found; });
  }

  start();

  function needEditor() {
    if (!ui || !shown) throw new Error("draw.io is still opening the diagram. Try again in a moment.");
    return ui;
  }

  function pageFor(name) {
    var editorUi = needEditor();
    if (name === undefined || name === null || name === "") return editorUi.currentPage;
    var list = editorUi.pages || [];
    for (var index = 0; index < list.length; index++) {
      if (list[index].getId() === name || list[index].getName() === name) return list[index];
    }
    throw new Error("This diagram has no page called " + name + ". Read the diagram to see its pages.");
  }

  function goTo(name) {
    var page = pageFor(name);
    if (page && page !== ui.currentPage) ui.selectPage(page);
    return page;
  }

  function plainText(cell) {
    var graph = ui.editor.graph;
    var label = graph.convertValueToString(cell);
    if (label == null) return "";
    label = String(label);
    if (!graph.isHtmlLabel(cell)) return label;
    var parsed = new DOMParser().parseFromString(label.replace(/<br\s*\/?>/gi, "\n"), "text/html");
    return parsed.body ? parsed.body.textContent || "" : label;
  }

  function labelValue(cell, style, text) {
    var html = /(^|;)html=1(;|$)/.test(style || "");
    if (!html) return text;
    return window.mxUtils.htmlEntities(String(text), false).replace(/\n/g, "<br>");
  }

  function describe(cell, model) {
    var parent = model.getParent(cell);
    var result = { id: String(cell.id) };
    if (parent && model.getParent(parent) == null) result.kind = "layer";
    else if (model.isEdge(cell)) result.kind = "edge";
    else if (model.isVertex(cell)) result.kind = model.getChildCount(cell) > 0 ? "group" : "vertex";
    else result.kind = "cell";
    var label = plainText(cell);
    if (label) result.label = label;
    if (cell.style) result.style = cell.style;
    if (parent) result.parent = String(parent.id);
    var geometry = model.getGeometry(cell);
    if (geometry && result.kind !== "edge" && result.kind !== "layer") {
      result.x = geometry.x;
      result.y = geometry.y;
      result.width = geometry.width;
      result.height = geometry.height;
    }
    if (cell.source) result.source = String(cell.source.id);
    if (cell.target) result.target = String(cell.target.id);
    return result;
  }

  function readDiagram(input) {
    var editorUi = needEditor();
    var page = pageFor(input.page);
    var root = rootOf(page);
    var model = page === editorUi.currentPage ? editorUi.editor.graph.model : new window.mxGraphModel(root);
    var list = [];
    walk(root, function (cell) {
      if (cell !== root) list.push(describe(cell, model));
    });
    var result = {
      file: fileName || null,
      pages: (editorUi.pages || []).map(function (each) {
        return { id: each.getId(), name: each.getName(), current: each === editorUi.currentPage };
      }),
      page: pageIdOf(page),
      cells: list,
    };
    if (page === editorUi.currentPage) {
      result.selection = editorUi.editor.graph.getSelectionCells().map(function (cell) { return String(cell.id); });
    }
    if (input.xml === true) {
      result.xml = window.mxUtils.getXml(new window.mxCodec(window.mxUtils.createXmlDocument()).encode(model));
    }
    return result;
  }

  function insertPoint(graph) {
    if (typeof graph.getFreeInsertPoint === "function") {
      var free = graph.getFreeInsertPoint();
      if (free) return { x: free.x, y: free.y };
    }
    return { x: 40, y: 40 };
  }

  function finish(graph, inserted) {
    if (!inserted.length) return;
    graph.setSelectionCells(inserted);
    graph.scrollCellToVisible(inserted[0]);
  }

  function addCells(input) {
    var editorUi = needEditor();
    goTo(input.page);
    var graph = editorUi.editor.graph;
    var model = graph.model;
    if (typeof input.xml === "string" && input.xml.trim()) {
      var parsed = editorUi.stringToCells(input.xml);
      if (!parsed.length) throw new Error("That XML has no draw.io cells in it.");
      var origin = insertPoint(graph);
      var bounds = graph.getBoundingBoxFromGeometry(parsed, true);
      var dx = typeof input.x === "number" ? input.x : origin.x;
      var dy = typeof input.y === "number" ? input.y : origin.y;
      var imported = graph.importCells(parsed, bounds ? dx - bounds.x : dx, bounds ? dy - bounds.y : dy, graph.getDefaultParent());
      finish(graph, imported);
      return { added: imported.map(function (cell) { return String(cell.id); }) };
    }
    var items = Array.isArray(input.cells) ? input.cells : [];
    if (!items.length) throw new Error("Give the cells to add, or draw.io XML.");
    var made = new Map();
    var added = [];
    var start = insertPoint(graph);
    var cursor = { x: start.x, y: start.y };
    var lookup = function (id) {
      if (typeof id !== "string" || !id) return null;
      return made.get(id) || model.getCell(id);
    };
    model.beginUpdate();
    try {
      items.forEach(function (raw) {
        var item = object(raw);
        if (item.type !== "edge" && !(item.type === undefined && (item.source || item.target))) {
          var style = typeof item.style === "string" ? item.style : VERTEX_STYLE;
          var width = typeof item.width === "number" ? item.width : 120;
          var height = typeof item.height === "number" ? item.height : 60;
          var x = typeof item.x === "number" ? item.x : cursor.x;
          var y = typeof item.y === "number" ? item.y : cursor.y;
          if (typeof item.x !== "number") cursor.x += width + 40;
          var vertex = graph.insertVertex(
            lookup(item.parent) || graph.getDefaultParent(),
            typeof item.id === "string" && item.id && !model.getCell(item.id) ? item.id : null,
            labelValue(null, style, item.label == null ? "" : item.label),
            x,
            y,
            width,
            height,
            style,
          );
          if (typeof item.id === "string" && item.id) made.set(item.id, vertex);
          added.push(vertex);
        }
      });
      items.forEach(function (raw) {
        var item = object(raw);
        if (!(item.type === "edge" || (item.type === undefined && (item.source || item.target)))) return;
        var style = typeof item.style === "string" ? item.style : EDGE_STYLE;
        var source = lookup(item.source);
        var target = lookup(item.target);
        if (!source) throw new Error("There's no cell " + (item.source || "given") + " to start the connector from.");
        if (!target) throw new Error("There's no cell " + (item.target || "given") + " to end the connector at.");
        var edge = graph.insertEdge(
          lookup(item.parent) || graph.getDefaultParent(),
          typeof item.id === "string" && item.id && !model.getCell(item.id) ? item.id : null,
          labelValue(null, style, item.label == null ? "" : item.label),
          source,
          target,
          style,
        );
        if (typeof item.id === "string" && item.id) made.set(item.id, edge);
        added.push(edge);
      });
    } finally {
      model.endUpdate();
    }
    finish(graph, added);
    var ids = {};
    made.forEach(function (cell, asked) { ids[asked] = String(cell.id); });
    return { added: added.map(function (cell) { return String(cell.id); }), ids: ids };
  }

  function changeCells(input) {
    var editorUi = needEditor();
    goTo(input.page);
    var graph = editorUi.editor.graph;
    var model = graph.model;
    var changes = Array.isArray(input.changes) ? input.changes : [];
    if (!changes.length) throw new Error("Give the changes to make, each with the id of its cell.");
    var changed = [];
    var missing = [];
    model.beginUpdate();
    try {
      changes.forEach(function (raw) {
        var change = object(raw);
        var cell = typeof change.id === "string" ? model.getCell(change.id) : null;
        if (!cell) {
          missing.push(change.id);
          return;
        }
        if (typeof change.style === "string") model.setStyle(cell, change.style);
        Object.keys(object(change.set_style)).forEach(function (key) {
          var value = change.set_style[key];
          graph.setCellStyles(key, value === null || value === undefined ? null : String(value), [cell]);
        });
        if (change.label !== undefined) {
          var text = change.label == null ? "" : String(change.label);
          if (window.mxUtils.isNode(cell.value)) graph.setAttributeForCell(cell, "label", labelValue(cell, cell.style, text));
          else model.setValue(cell, labelValue(cell, cell.style, text));
        }
        var moves = ["x", "y", "width", "height"].filter(function (key) { return typeof change[key] === "number"; });
        if (moves.length && model.getGeometry(cell)) {
          var geometry = model.getGeometry(cell).clone();
          moves.forEach(function (key) { geometry[key] = change[key]; });
          model.setGeometry(cell, geometry);
        }
        if (change.source !== undefined) model.setTerminal(cell, change.source ? model.getCell(change.source) : null, true);
        if (change.target !== undefined) model.setTerminal(cell, change.target ? model.getCell(change.target) : null, false);
        if (typeof change.parent === "string") {
          var parent = model.getCell(change.parent);
          if (!parent) throw new Error("There's no cell " + change.parent + " to move " + change.id + " into.");
          model.add(parent, cell);
        }
        changed.push(String(cell.id));
      });
    } finally {
      model.endUpdate();
    }
    return missing.length ? { changed: changed, missing: missing } : { changed: changed };
  }

  function deleteCells(input) {
    var editorUi = needEditor();
    goTo(input.page);
    var graph = editorUi.editor.graph;
    var model = graph.model;
    var ids = Array.isArray(input.ids) ? input.ids : [];
    var found = [];
    var missing = [];
    ids.forEach(function (id) {
      var cell = typeof id === "string" ? model.getCell(id) : null;
      if (cell && cell !== model.getRoot()) found.push(cell);
      else missing.push(id);
    });
    if (!found.length) throw new Error("None of those cells are on this page.");
    var removed = graph.removeCells(found, input.include_edges !== false) || found;
    var result = { deleted: removed.map(function (cell) { return String(cell.id); }) };
    if (missing.length) result.missing = missing;
    return result;
  }

  function addMermaid(input, agent) {
    var editorUi = needEditor();
    goTo(input.page);
    var text = typeof input.mermaid === "string" ? input.mermaid.trim() : "";
    if (!text) throw new Error("Give the diagram in Mermaid.");
    var EditorUi = window.EditorUi;
    var ready = EditorUi.isMermaidSupported()
      ? Promise.resolve()
      : new Promise(function (resolve, reject) { editorUi.loadMermaid(resolve, reject); });
    return ready
      .then(function () {
        if (!EditorUi.isMermaidSupported()) throw new Error("draw.io's Mermaid converter isn't available here.");
        var version = typeof EditorUi.getInsertMermaidVersion === "function" ? EditorUi.getInsertMermaidVersion() : null;
        return new Promise(function (resolve, reject) {
          editorUi.parseMermaidDiagram(
            text,
            null,
            function (xml) {
              var wrapper = window.mxMermaidToDrawio && window.mxMermaidToDrawio.wrapGroup;
              if (typeof wrapper === "function") {
                xml = wrapper(xml, text, EditorUi.getInsertMermaidConfig(), version != null ? { version: version } : null);
              }
              resolve(xml);
            },
            function (error) {
              reject(new Error(error && error.message ? error.message : "draw.io couldn't read that Mermaid."));
            },
            null,
            version,
          );
        });
      })
      .then(function (xml) {
        var graph = editorUi.editor.graph;
        var parsed = editorUi.stringToCells(xml);
        if (!parsed.length) throw new Error("That Mermaid made no shapes.");
        var origin = insertPoint(graph);
        var x = typeof input.x === "number" ? input.x : origin.x;
        var y = typeof input.y === "number" ? input.y : origin.y;
        var bounds = graph.getBoundingBoxFromGeometry(parsed, true);
        return asAgent(agent, function () {
          var imported = graph.importCells(parsed, bounds ? x - bounds.x : x, bounds ? y - bounds.y : y, graph.getDefaultParent());
          finish(graph, imported);
          return { added: imported.map(function (cell) { return String(cell.id); }) };
        });
      });
  }

  function baseName() {
    var name = fileName || "Diagram";
    return name.replace(/\.drawio\.svg$/i, "").replace(/\.(drawio|svg|xml)$/i, "") || "Diagram";
  }

  function bytesOfDataUri(uri) {
    var comma = uri.indexOf(",");
    if (comma < 0) throw new Error("draw.io returned no picture.");
    var head = uri.slice(0, comma);
    var body = uri.slice(comma + 1);
    if (/;base64$/i.test(head)) {
      var binary = atob(body);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  }

  function exportDiagram(input) {
    var editorUi = needEditor();
    var format = input.format === "png" || input.format === "drawio" ? input.format : "svg";
    goTo(input.page);
    var made;
    if (format === "drawio") {
      made = Promise.resolve({
        bytes: new TextEncoder().encode(editorUi.getFileData(true)),
        mime: "application/vnd.jgraph.mxfile",
        extension: ".drawio",
      });
    } else {
      made = ask("export", { format: format === "png" ? "xmlpng" : "xmlsvg", currentPage: true, border: 10 }).then(function (reply) {
        if (typeof reply.data !== "string") throw new Error("draw.io returned no picture.");
        return {
          bytes: bytesOfDataUri(reply.data),
          mime: format === "png" ? "image/png" : "image/svg+xml",
          extension: format === "png" ? ".png" : ".svg",
        };
      });
    }
    return made.then(function (result) {
      var requested = typeof input.name === "string" && input.name.trim() ? input.name.trim() : baseName();
      var name = requested.toLowerCase().endsWith(result.extension) ? requested : requested + result.extension;
      if (!misty) {
        if (format === "png") throw new Error("This copy of draw.io isn't in a Space, so the picture can't be saved.");
        return { name: name, content: new TextDecoder().decode(result.bytes) };
      }
      var options = { name: name, mime: result.mime, data: result.bytes };
      if (fileFolder) options.folder = fileFolder;
      return misty.files.save(options).then(function (file) {
        return { file: { id: file.id, name: file.name } };
      });
    });
  }

  var tools = [
    {
      name: "read_diagram",
      description:
        "Read the open diagram: its pages, and the cells of one page (the current one unless page is given), each with its id, kind (layer, vertex, group or edge), label, style, parent, position and size, and the source and target of edges, plus what the person has selected. Pass xml: true for the page's draw.io XML as well.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "A page's id or name; the current page when left out." },
          xml: { type: "boolean", description: "Also return the page's draw.io XML." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "add_cells",
      description:
        "Add shapes and connectors to a page of the diagram, as one change the person can undo. Give cells: vertices with a label, x, y, width, height and a draw.io style (such as \"ellipse;whiteSpace=wrap;html=1;\"), and edges with a source and target (ids of existing cells or of vertices in this same call). Or give xml: draw.io XML of cells to insert. Shapes without a position go where there's room.",
      inputSchema: {
        type: "object",
        properties: {
          cells: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "An id to give it, so edges in this call can refer to it." },
                type: { type: "string", enum: ["vertex", "edge"] },
                label: { type: "string" },
                style: { type: "string", description: "A draw.io style string." },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                parent: { type: "string", description: "A group or layer to put it in." },
                source: { type: "string", description: "For an edge: the cell it starts at." },
                target: { type: "string", description: "For an edge: the cell it ends at." },
              },
              additionalProperties: false,
            },
          },
          xml: { type: "string", description: "draw.io XML of cells to insert instead of cells." },
          x: { type: "number", description: "With xml: where its top left corner goes." },
          y: { type: "number", description: "With xml: where its top left corner goes." },
          page: { type: "string", description: "A page's id or name; the current page when left out." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "change_cells",
      description:
        "Change cells of the diagram by id, as one change the person can undo: a new label, a whole style, single style keys (set_style, null removes a key, such as {\"fillColor\": \"#dae8fc\"}), position and size, an edge's source or target, or the group or layer a cell is in. Read the diagram first for the ids.",
      inputSchema: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                style: { type: "string" },
                set_style: { type: "object", additionalProperties: { type: ["string", "number", "null"] } },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                source: { type: ["string", "null"] },
                target: { type: ["string", "null"] },
                parent: { type: "string" },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
          page: { type: "string", description: "A page's id or name; the current page when left out." },
        },
        required: ["changes"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "delete_cells",
      description:
        "Delete cells from the diagram by id, as one change the person can undo. Connectors attached to a deleted shape go with it unless include_edges is false.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          include_edges: { type: "boolean" },
          page: { type: "string", description: "A page's id or name; the current page when left out." },
        },
        required: ["ids"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "add_mermaid",
      description:
        "Add a diagram written in Mermaid (a flowchart, sequence, class, state or ER diagram and the rest) to a page, turned into editable draw.io shapes by draw.io's own converter, as one change the person can undo.",
      inputSchema: {
        type: "object",
        properties: {
          mermaid: { type: "string", description: "The diagram in Mermaid." },
          x: { type: "number", description: "Where its top left corner goes; where there's room when left out." },
          y: { type: "number" },
          page: { type: "string", description: "A page's id or name; the current page when left out." },
        },
        required: ["mermaid"],
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
    {
      name: "export",
      description:
        "Export a page of the diagram into the Space's files, beside the diagram: svg or png (both keep the diagram inside them, so draw.io can open them again), or drawio for a copy of the whole file. Returns the saved file.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["svg", "png", "drawio"] },
          name: { type: "string", description: "The file's name; the diagram's own name when left out." },
          page: { type: "string", description: "A page's id or name; the current page when left out." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
  ];

  function agentFor(context) {
    var sdk = window.MistySDK;
    if (!bound || !room || !sdk || typeof sdk.agentOfCall !== "function") return null;
    var agent = sdk.agentOfCall(context);
    if (!agent) return null;
    return sdk.joinAsAgent(room, agent, {
      scope: function (mirror) { return [mirror.getMap(CELLS), mirror.getMap(PAGES)]; },
    });
  }

  function idsOf(result) {
    var found = object(result);
    var ids = [].concat(found.added || [], found.changed || []);
    return ids.filter(function (id) { return typeof id === "string"; }).slice(0, MAX_SELECTION);
  }

  function asAgent(agent, run) {
    if (!agent) return run();
    var history = ui.editor.undoManager;
    var start = history.indexOfNextAdd;
    var kept = { doc: doc, cells: cells, pages: pages };
    doc = agent.doc;
    cells = doc.getMap(CELLS);
    pages = doc.getMap(PAGES);
    var result;
    try {
      result = run();
    } finally {
      doc = kept.doc;
      cells = kept.cells;
      pages = kept.pages;
      if (history.history.length > start) {
        history.history.splice(start);
        history.indexOfNextAdd = history.history.length;
        history.fireEvent(new window.mxEventObject(window.mxEvent.CLEAR));
      }
    }
    agent.setPresence({ drawio: { page: pageIdOf(currentPage()), selection: idsOf(result) } });
    return result;
  }

  function call(name, args, context) {
    var input = object(args);
    try {
      var agent = name === "read_diagram" || name === "export" ? null : agentFor(context);
      switch (name) {
        case "read_diagram":
          return Promise.resolve(readDiagram(input));
        case "add_cells":
          return Promise.resolve(asAgent(agent, function () { return addCells(input); }));
        case "change_cells":
          return Promise.resolve(asAgent(agent, function () { return changeCells(input); }));
        case "delete_cells":
          return Promise.resolve(asAgent(agent, function () { return deleteCells(input); }));
        case "add_mermaid":
          return addMermaid(input, agent);
        case "undo_my_change":
          if (!agent) throw new Error("Only a live diagram keeps each agent's own changes to undo.");
          return Promise.resolve({ undone: agent.undo() });
        case "export":
          return exportDiagram(input);
        default:
          throw new Error("draw.io has no tool called " + name + ".");
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }

  window.mistyAdapter = { tools: tools, call: call };
})();
