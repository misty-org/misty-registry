(function () {
  "use strict";

  var OBJECTS = "three:objects";
  var PLACES = "three:places";
  var EXTENSION = ".three";
  var MIME = "application/json";
  var LOCAL = { three: true };

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
  var spaceDecided = deferred();
  var editor = null;
  var misty = null;
  var room = null;
  var doc = null;
  var bound = false;
  var applying = false;
  var known = new Map();
  var onLocalChange = null;
  var fileName = "";

  function gateStorage(found) {
    var storage = found.storage;
    if (!storage) return;
    var get = storage.get;
    var set = storage.set;
    storage.get = function (callback) {
      spaceDecided.promise.then(function (inSpace) {
        if (inSpace) callback(undefined);
        else get.call(storage, callback);
      });
    };
    storage.set = function () {
      if (misty) return;
      return set.apply(storage, arguments);
    };
  }

  (function capture() {
    var held;
    try {
      Object.defineProperty(window, "editor", {
        configurable: true,
        get: function () { return held; },
        set: function (value) {
          held = value;
          Object.defineProperty(window, "editor", { configurable: true, writable: true, value: value });
          if (value && value.signals && value.scene) {
            gateStorage(value);
            editorReady.resolve(value);
          }
        },
      });
    } catch (error) {
      editorReady.reject(error);
    }
  })();

  function three() {
    if (!window.THREE || !window.THREE.ObjectLoader) throw new Error("three.js isn't loaded yet.");
    return window.THREE;
  }

  function entryOf(node) {
    var kids = node.children;
    node.children = [];
    try {
      return JSON.stringify(node.toJSON());
    } finally {
      node.children = kids;
    }
  }

  function placesOf(scene) {
    var places = {};
    var nodes = {};
    places[scene.uuid] = JSON.stringify({ parent: null, index: 0 });
    nodes[scene.uuid] = scene;
    scene.traverse(function (node) {
      node.children.forEach(function (child, index) {
        places[child.uuid] = JSON.stringify({ parent: node.uuid, index: index });
        nodes[child.uuid] = child;
      });
    });
    return { places: places, nodes: nodes };
  }

  function writeScene(target, scene) {
    var found = placesOf(scene);
    var objects = target.getMap(OBJECTS);
    var places = target.getMap(PLACES);
    Object.keys(found.places).forEach(function (uuid) {
      var entry = entryOf(found.nodes[uuid]);
      if (objects.get(uuid) !== entry) objects.set(uuid, entry);
      if (places.get(uuid) !== found.places[uuid]) places.set(uuid, found.places[uuid]);
    });
    var stale = [];
    places.forEach(function (value, uuid) {
      if (!(uuid in found.places)) stale.push(uuid);
    });
    objects.forEach(function (value, uuid) {
      if (!(uuid in found.places) && stale.indexOf(uuid) < 0) stale.push(uuid);
    });
    stale.forEach(function (uuid) {
      places.delete(uuid);
      objects.delete(uuid);
    });
  }

  function sceneFromJson(json) {
    var data = object(json);
    if (data.scene && object(data.metadata).type === "App") data = data.scene;
    var parsed = new (three().ObjectLoader)().parse(data);
    if (parsed && parsed.isScene) return parsed;
    var scene = new (three().Scene)();
    if (parsed) scene.add(parsed);
    return scene;
  }

  function assemble(current) {
    var objects = current.getMap(OBJECTS);
    var places = current.getMap(PLACES);
    var lists = ["geometries", "materials", "textures", "images", "shapes", "skeletons", "animations", "nodes"];
    var out = { metadata: { version: 4.6, type: "Object", generator: "Object3D.toJSON" } };
    var seen = {};
    lists.forEach(function (key) {
      out[key] = [];
      seen[key] = new Set();
    });
    var nodes = {};
    objects.forEach(function (value, uuid) {
      var entry = parse(value);
      if (!entry || !entry.object) return;
      lists.forEach(function (key) {
        (Array.isArray(entry[key]) ? entry[key] : []).forEach(function (item) {
          if (item && item.uuid && !seen[key].has(item.uuid)) {
            seen[key].add(item.uuid);
            out[key].push(item);
          }
        });
      });
      entry.object.children = [];
      nodes[uuid] = entry.object;
    });
    var root = null;
    var placed = [];
    places.forEach(function (value, uuid) {
      var place = parse(value);
      if (!place || !nodes[uuid]) return;
      if (place.parent === null) root = uuid;
      else placed.push({ uuid: uuid, parent: place.parent, index: place.index });
    });
    placed.sort(function (left, right) { return left.index - right.index || (left.uuid < right.uuid ? -1 : 1); });
    placed.forEach(function (place) {
      if (nodes[place.parent]) nodes[place.parent].children.push(nodes[place.uuid]);
    });
    Object.keys(nodes).forEach(function (uuid) {
      if (!nodes[uuid].children.length) delete nodes[uuid].children;
    });
    lists.forEach(function (key) {
      if (!out[key].length) delete out[key];
    });
    out.object = root ? nodes[root] : new (three().Scene)().toJSON().object;
    return out;
  }

  function sceneText() {
    return JSON.stringify(editor.scene.toJSON());
  }

  var dirty = new Set();
  var flushQueued = false;

  function mark(node, deep) {
    if (applying) return;
    if (node && node.isObject3D) {
      if (deep) node.traverse(function (child) { dirty.add(child); });
      else dirty.add(node);
    }
    if (flushQueued) return;
    flushQueued = true;
    Promise.resolve().then(flush);
  }

  function flush() {
    flushQueued = false;
    var changed = dirty;
    dirty = new Set();
    if (onLocalChange) onLocalChange();
    if (!bound) return;
    var found = placesOf(editor.scene);
    var objects = doc.getMap(OBJECTS);
    var places = doc.getMap(PLACES);
    doc.transact(function () {
      changed.forEach(function (node) {
        if (!(node.uuid in found.places)) return;
        var entry = entryOf(node);
        known.set(node.uuid, entry);
        if (objects.get(node.uuid) !== entry) objects.set(node.uuid, entry);
      });
      Object.keys(found.places).forEach(function (uuid) {
        if (places.get(uuid) !== found.places[uuid]) places.set(uuid, found.places[uuid]);
        if (!objects.has(uuid)) {
          var entry = entryOf(found.nodes[uuid]);
          known.set(uuid, entry);
          objects.set(uuid, entry);
        }
      });
      var stale = [];
      places.forEach(function (value, uuid) {
        if (!(uuid in found.places)) stale.push(uuid);
      });
      stale.forEach(function (uuid) {
        places.delete(uuid);
        objects.delete(uuid);
        known.delete(uuid);
      });
    }, LOCAL);
  }

  function watchSignals() {
    var signals = editor.signals;
    var on = function (name, handler) {
      if (signals[name] && typeof signals[name].add === "function") signals[name].add(handler);
    };
    on("objectChanged", function (node) { mark(node); });
    on("objectAdded", function (node) { mark(node, true); });
    on("objectRemoved", function () { mark(null); });
    on("geometryChanged", function (node) { mark(node || editor.selected); });
    on("materialChanged", function (node) { mark(node || editor.selected); });
    on("sceneGraphChanged", function () { mark(null); });
    ["sceneBackgroundChanged", "sceneEnvironmentChanged", "sceneFogChanged", "sceneFogSettingsChanged"].forEach(function (name) {
      on(name, function () { mark(editor.scene); });
    });
  }

  function copySceneProps(entry) {
    var parsed = sceneFromJson(parse(entry));
    var scene = editor.scene;
    scene.name = parsed.name;
    scene.background = parsed.background;
    scene.environment = parsed.environment;
    scene.fog = parsed.fog;
    scene.backgroundBlurriness = parsed.backgroundBlurriness;
    scene.backgroundIntensity = parsed.backgroundIntensity;
    scene.userData = parsed.userData;
  }

  function nodeFromEntry(entry) {
    var data = parse(entry);
    if (!data) return null;
    var node = new (three().ObjectLoader)().parse(data);
    node.children.slice().forEach(function (child) { node.remove(child); });
    return node;
  }

  function depthOf(uuid, wanted) {
    var depth = 0;
    var at = wanted[uuid];
    while (at && at.parent !== null && depth < 1000) {
      depth++;
      at = wanted[at.parent];
    }
    return depth;
  }

  function applyRoom() {
    applyQueued = false;
    if (!bound) return;
    var objects = doc.getMap(OBJECTS);
    var placesMap = doc.getMap(PLACES);
    var wanted = {};
    var root = null;
    placesMap.forEach(function (value, uuid) {
      var place = parse(value);
      if (!place) return;
      wanted[uuid] = place;
      if (place.parent === null) root = uuid;
    });
    if (!root) return;
    var selected = editor.selected ? editor.selected.uuid : null;
    var nodes = placesOf(editor.scene).nodes;
    var pending = {};
    applying = true;
    try {
      if (editor.scene.uuid !== root) {
        delete nodes[editor.scene.uuid];
        editor.scene.uuid = root;
        nodes[root] = editor.scene;
      }
      objects.forEach(function (entry, uuid) {
        if (known.get(uuid) === entry) return;
        known.set(uuid, entry);
        if (uuid === root) {
          copySceneProps(entry);
          return;
        }
        var fresh = nodeFromEntry(entry);
        if (!fresh) return;
        var old = nodes[uuid];
        if (!old || !old.parent) {
          pending[uuid] = fresh;
          return;
        }
        var parent = old.parent;
        var index = parent.children.indexOf(old);
        var kids = old.children.slice();
        editor.removeObject(old);
        kids.forEach(function (kid) {
          old.remove(kid);
          fresh.add(kid);
        });
        editor.addObject(fresh, parent, index);
        nodes[uuid] = fresh;
      });
      var order = Object.keys(wanted)
        .filter(function (uuid) { return uuid !== root; })
        .sort(function (left, right) { return depthOf(left, wanted) - depthOf(right, wanted); });
      var touched = new Set();
      order.forEach(function (uuid) {
        var place = wanted[uuid];
        var parent = nodes[place.parent];
        var node = nodes[uuid] || pending[uuid];
        if (!parent || !node) return;
        if (pending[uuid]) {
          editor.addObject(node, parent, Math.min(place.index, parent.children.length));
          nodes[uuid] = node;
          delete pending[uuid];
        } else if (node.parent !== parent) {
          if (node.parent) node.parent.remove(node);
          parent.children.splice(Math.min(place.index, parent.children.length), 0, node);
          node.parent = parent;
        }
        touched.add(parent);
      });
      touched.forEach(function (parent) {
        parent.children.sort(function (left, right) {
          var a = wanted[left.uuid];
          var b = wanted[right.uuid];
          return (a ? a.index : Infinity) - (b ? b.index : Infinity);
        });
      });
      Object.keys(nodes).forEach(function (uuid) {
        if (uuid === root || wanted[uuid]) return;
        var node = nodes[uuid];
        if (node.parent) editor.removeObject(node);
        known.delete(uuid);
      });
      if (selected && nodes[selected] && editor.selected && editor.selected.uuid === selected && editor.selected !== nodes[selected]) {
        editor.select(nodes[selected]);
      }
      editor.signals.sceneGraphChanged.dispatch();
    } finally {
      applying = false;
    }
  }

  var applyQueued = false;

  function applySoon() {
    if (applyQueued) return;
    applyQueued = true;
    Promise.resolve().then(applyRoom);
  }

  function loadFromFile(data, scratch) {
    var json = parse(new TextDecoder().decode(data));
    var scene = json ? sceneFromJson(json) : editor.scene;
    scratch.transact(function () { writeScene(scratch, scene); });
  }

  function serialize(current) {
    return JSON.stringify(assemble(current));
  }

  function bind() {
    if (bound) return;
    bound = true;
    applyRoom();
  }

  var marks = new Map();
  var redrawQueued = false;

  function viewportDom() {
    return document.getElementById("viewport");
  }

  function dropMark(clientId) {
    var mark = marks.get(clientId);
    if (!mark) return;
    marks.delete(clientId);
    if (mark.box.parent) mark.box.parent.remove(mark.box);
    if (mark.box.geometry) mark.box.geometry.dispose();
    if (mark.tag.parentNode) mark.tag.parentNode.removeChild(mark.tag);
  }

  function redraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    Promise.resolve().then(function () {
      redrawQueued = false;
      if (editor) editor.signals.cameraChanged.dispatch(editor.viewportCamera);
    });
  }

  function selectedOf(state) {
    var record = object(state);
    var own = object(record.three);
    var presence = object(record.presence);
    var uuid = own.selected || presence.selected;
    return typeof uuid === "string" ? uuid : null;
  }

  function paintPeers() {
    if (!room || !editor || !window.MistySDK || typeof window.MistySDK.peersOf !== "function") return;
    var T = three();
    var seen = new Set();
    window.MistySDK.peersOf(room).forEach(function (peer) {
      var uuid = selectedOf(peer.state);
      var node = uuid ? editor.objectByUuid(uuid) : null;
      if (!node || node === editor.scene) return;
      seen.add(peer.clientId);
      var mark = marks.get(peer.clientId);
      if (mark && (mark.node !== node || mark.name !== peer.name)) {
        dropMark(peer.clientId);
        mark = null;
      }
      if (!mark) {
        var box = new T.BoxHelper(node, peer.color);
        box.material.depthTest = false;
        box.material.transparent = true;
        editor.sceneHelpers.add(box);
        var tag = document.createElement("div");
        tag.textContent = peer.name || "Someone";
        tag.style.cssText =
          "position:absolute;pointer-events:none;padding:0 4px;border-radius:4px;font:11px system-ui,sans-serif;" +
          "white-space:nowrap;color:#3c3836;transform:translate(-50%,-100%);background:" + peer.color;
        var dom = viewportDom();
        if (dom) dom.appendChild(tag);
        mark = { box: box, tag: tag, node: node, name: peer.name };
        marks.set(peer.clientId, mark);
      }
    });
    Array.from(marks.keys()).forEach(function (clientId) {
      if (!seen.has(clientId)) dropMark(clientId);
    });
    redraw();
  }

  function placeTags() {
    if (!marks.size || !editor) return;
    var T = three();
    var dom = viewportDom();
    if (!dom) return;
    var width = dom.clientWidth;
    var height = dom.clientHeight;
    marks.forEach(function (mark) {
      mark.box.update();
      var bounds = new T.Box3().setFromObject(mark.node);
      if (bounds.isEmpty()) {
        mark.tag.style.display = "none";
        return;
      }
      var top = new T.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.max.y, (bounds.min.z + bounds.max.z) / 2);
      top.project(editor.viewportCamera);
      var visible = top.z > -1 && top.z < 1;
      mark.tag.style.display = visible ? "" : "none";
      mark.tag.style.left = Math.round(((top.x + 1) / 2) * width) + "px";
      mark.tag.style.top = Math.round(((1 - top.y) / 2) * height - 4) + "px";
    });
  }

  function publishSelection(node) {
    if (!room) return;
    room.awareness.setLocalStateField("three", { selected: node && node !== editor.scene ? node.uuid : null });
  }

  function watchPresence() {
    room.awareness.on("change", paintPeers);
    editor.signals.objectSelected.add(publishSelection);
    editor.signals.sceneRendered.add(placeTags);
    editor.signals.sceneGraphChanged.add(function () {
      if (marks.size) paintPeers();
    });
    publishSelection(editor.selected);
    paintPeers();
  }

  function goLive(fileRoom) {
    room = fileRoom;
    doc = fileRoom.doc;
    var found = placesOf(editor.scene);
    Object.keys(found.nodes).forEach(function (uuid) {
      if (!known.has(uuid)) known.set(uuid, entryOf(found.nodes[uuid]));
    });
    var observe = function (event) {
      if (event.transaction.origin === LOCAL) return;
      applySoon();
    };
    doc.getMap(OBJECTS).observe(observe);
    doc.getMap(PLACES).observe(observe);
    bind();
    watchPresence();
  }

  function showScene(scene) {
    applying = true;
    try {
      editor.clear();
      editor.setScene(scene);
    } finally {
      applying = false;
    }
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

  var opened = null;

  function start() {
    var module = null;
    var connected = sdk().then(function (found) {
      module = found;
      if (!found) return null;
      return found.connect({ applyTheme: false }).catch(function () { return null; });
    });
    connected.then(function (found) {
      misty = found;
      spaceDecided.resolve(!!found);
    });
    Promise.all([editorReady.promise, connected]).then(function (results) {
      editor = results[0];
      watchSignals();
      if (!misty) return;
      onLocalChange = function () {
        if (opened && (opened.file || editor.scene.children.length)) opened.changed();
      };
      opened = module.openDocument(misty, {
        extension: EXTENSION,
        mime: MIME,
        name: "Scene",
        load: loadFromFile,
        serialize: serialize,
        current: sceneText,
        show: function (data) {
          var json = parse(new TextDecoder().decode(data));
          if (json) showScene(sceneFromJson(json));
        },
        live: goLive,
      });
      opened.onFile(function (file) {
        fileName = file.name || fileName;
      });
    }).catch(function () {});
  }

  start();

  function needEditor() {
    if (!editor) throw new Error("The three.js editor is still starting. Try again in a moment.");
    return editor;
  }

  function vector(value) {
    return Array.isArray(value) && value.length === 3 && value.every(function (part) { return typeof part === "number" && isFinite(part); });
  }

  function describe(node) {
    var out = {
      uuid: node.uuid,
      type: node.type,
      name: node.name || undefined,
      position: node.position.toArray(),
      rotation: [node.rotation.x, node.rotation.y, node.rotation.z].map(function (radians) { return Math.round((radians * 180) / Math.PI * 1000) / 1000; }),
      scale: node.scale.toArray(),
      visible: node.visible,
    };
    if (node.geometry) out.geometry = node.geometry.type;
    if (node.material && node.material.color) out.color = "#" + node.material.color.getHexString();
    if (node.isLight && node.color) out.color = "#" + node.color.getHexString();
    if (node.children.length) out.children = node.children.map(describe);
    return out;
  }

  function find(uuid) {
    var node = typeof uuid === "string" ? needEditor().objectByUuid(uuid) : null;
    if (!node || node === editor.scene) throw new Error("The scene has no object " + uuid + ". Read the scene to see its objects.");
    return node;
  }

  function place(node, input) {
    var T = three();
    if (vector(input.position)) node.position.fromArray(input.position);
    if (vector(input.rotation)) node.rotation.set(input.rotation[0] * T.MathUtils.DEG2RAD, input.rotation[1] * T.MathUtils.DEG2RAD, input.rotation[2] * T.MathUtils.DEG2RAD);
    if (vector(input.scale)) node.scale.fromArray(input.scale);
    if (typeof input.name === "string") node.name = input.name;
    if (typeof input.visible === "boolean") node.visible = input.visible;
    if (typeof input.color === "string") {
      if (node.material && node.material.color) node.material.color.set(input.color);
      else if (node.isLight && node.color) node.color.set(input.color);
    }
  }

  var SHAPES = {
    box: function (T) { return new T.BoxGeometry(1, 1, 1); },
    sphere: function (T) { return new T.SphereGeometry(0.5, 32, 16); },
    cylinder: function (T) { return new T.CylinderGeometry(0.5, 0.5, 1, 32); },
    cone: function (T) { return new T.ConeGeometry(0.5, 1, 32); },
    torus: function (T) { return new T.TorusGeometry(0.5, 0.2, 16, 48); },
    plane: function (T) { return new T.PlaneGeometry(1, 1); },
  };
  var LIGHTS = {
    point_light: function (T) { return new T.PointLight(0xffffff, 1); },
    directional_light: function (T) { return new T.DirectionalLight(0xffffff, 1); },
    ambient_light: function (T) { return new T.AmbientLight(0x404040, 1); },
    spot_light: function (T) { return new T.SpotLight(0xffffff, 1); },
  };

  var tools = [
    {
      name: "read_scene",
      description: "Read the open 3D scene as a tree of its objects: each one's uuid, type, name, position, rotation in degrees, scale, color and children. Everyone with the scene open sees the same scene live.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "add_object",
      description: "Add an object to the scene: a shape (box, sphere, cylinder, cone, torus, plane) with a standard material, or a light (point_light, directional_light, ambient_light, spot_light). Optionally its name, position, rotation in degrees, scale, color (such as #ff8800) and the uuid of the object to put it in.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: Object.keys(SHAPES).concat(Object.keys(LIGHTS)) },
          name: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          color: { type: "string" },
          parent: { type: "string", description: "The uuid of the object to put it in; the scene when left out." },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "update_object",
      description: "Change an object by its uuid: its name, position, rotation in degrees, scale, color or whether it is visible.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string" },
          name: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          color: { type: "string" },
          visible: { type: "boolean" },
        },
        required: ["uuid"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "undo_my_change",
      description: "Take back your own last change to the scene, leaving everyone else's as they are.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
    {
      name: "remove_object",
      description: "Take an object, and everything in it, out of the scene by its uuid.",
      inputSchema: {
        type: "object",
        properties: { uuid: { type: "string" } },
        required: ["uuid"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
  ];

  function agentIn(context) {
    var sdk = window.MistySDK;
    if (!bound || !room || !sdk || typeof sdk.agentOfCall !== "function") return null;
    var agent = sdk.agentOfCall(context);
    if (!agent) return null;
    return sdk.joinAsAgent(room, agent, {
      scope: function (mirror) { return [mirror.getMap(OBJECTS), mirror.getMap(PLACES)]; },
    });
  }

  function snapshot(node) {
    return {
      position: node.position.clone(),
      rotation: node.rotation.clone(),
      scale: node.scale.clone(),
      name: node.name,
      visible: node.visible,
      color: node.material && node.material.color ? node.material.color.clone() : node.isLight && node.color ? node.color.clone() : null,
    };
  }

  function restore(node, before) {
    node.position.copy(before.position);
    node.rotation.copy(before.rotation);
    node.scale.copy(before.scale);
    node.name = before.name;
    node.visible = before.visible;
    if (before.color && node.material && node.material.color) node.material.color.copy(before.color);
    else if (before.color && node.isLight && node.color) node.color.copy(before.color);
  }

  function asAgent(agent, name, input) {
    var current = editor;
    var T = three();
    switch (name) {
      case "add_object": {
        var node;
        if (SHAPES[input.kind]) node = new T.Mesh(SHAPES[input.kind](T), new T.MeshStandardMaterial());
        else if (LIGHTS[input.kind]) node = LIGHTS[input.kind](T);
        else throw new Error("Pick a kind: " + Object.keys(SHAPES).concat(Object.keys(LIGHTS)).join(", ") + ".");
        node.name = input.kind.replace(/_/g, " ").replace(/^./, function (letter) { return letter.toUpperCase(); });
        place(node, input);
        var parent = typeof input.parent === "string" ? find(input.parent) : current.scene;
        var entry = entryOf(node);
        var spot = JSON.stringify({ parent: parent.uuid, index: parent.children.length });
        agent.transact(function (mirror) {
          mirror.getMap(OBJECTS).set(node.uuid, entry);
          mirror.getMap(PLACES).set(node.uuid, spot);
        });
        agent.setPresence({ selected: node.uuid });
        return { uuid: node.uuid };
      }
      case "update_object": {
        var target = find(input.uuid);
        var before = snapshot(target);
        place(target, input);
        var changed = entryOf(target);
        restore(target, before);
        agent.transact(function (mirror) {
          mirror.getMap(OBJECTS).set(target.uuid, changed);
        });
        agent.setPresence({ selected: target.uuid });
        return { uuid: target.uuid };
      }
      case "remove_object": {
        var gone = find(input.uuid);
        var uuids = [];
        gone.traverse(function (child) { uuids.push(child.uuid); });
        agent.transact(function (mirror) {
          var objects = mirror.getMap(OBJECTS);
          var places = mirror.getMap(PLACES);
          uuids.forEach(function (uuid) {
            objects.delete(uuid);
            places.delete(uuid);
          });
        });
        agent.setPresence(null);
        return { ok: true };
      }
      case "undo_my_change":
        return { undone: agent.undo() };
      default:
        return undefined;
    }
  }

  function call(name, args, context) {
    var input = object(args);
    var current = needEditor();
    var T = three();
    var agent = name === "read_scene" ? null : agentIn(context);
    if (agent) {
      var done = asAgent(agent, name, input);
      if (done !== undefined) return done;
    }
    switch (name) {
      case "read_scene":
        return { file: fileName || null, live: bound, scene: describe(current.scene) };
      case "add_object": {
        var node;
        if (SHAPES[input.kind]) node = new T.Mesh(SHAPES[input.kind](T), new T.MeshStandardMaterial());
        else if (LIGHTS[input.kind]) node = LIGHTS[input.kind](T);
        else throw new Error("Pick a kind: " + Object.keys(SHAPES).concat(Object.keys(LIGHTS)).join(", ") + ".");
        node.name = input.kind.replace(/_/g, " ").replace(/^./, function (letter) { return letter.toUpperCase(); });
        place(node, input);
        var parent = typeof input.parent === "string" ? find(input.parent) : current.scene;
        current.addObject(node, parent, parent.children.length);
        current.select(node);
        return { uuid: node.uuid };
      }
      case "update_object": {
        var target = find(input.uuid);
        place(target, input);
        current.signals.objectChanged.dispatch(target);
        if (typeof input.color === "string" && target.material) current.signals.materialChanged.dispatch(target, 0);
        return describe(target);
      }
      case "remove_object":
        current.removeObject(find(input.uuid));
        return { ok: true };
      case "undo_my_change":
        throw new Error("Only a live scene keeps each agent's own changes to undo.");
      default:
        throw new Error("The three.js editor has no tool called " + name + ".");
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
