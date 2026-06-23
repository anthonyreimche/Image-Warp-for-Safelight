//#region src/runtime.ts
let _react = null;
let _api = null;
function initRuntime(api) {
	_react = api.react;
	_api = api;
}
/** The scoped SafelightAPI captured at activate(). */
function api() {
	if (!_api) throw new Error("[image-warp] api used before activate()");
	return _api;
}
/** The app's React namespace (createElement, useState, useEffect, useRef, …). */
function R() {
	if (!_react) throw new Error("[image-warp] runtime used before activate()");
	return _react;
}
/** createElement shorthand. */
function h(type, props, ...children) {
	return R().createElement(type, props, ...children);
}
//#endregion
//#region src/store.ts
let _store = null;
function initStore() {
	_store = api().stores.create((set) => ({
		warpActive: false,
		tool: "push",
		size: 0.14,
		pressure: 1,
		rate: 0.5,
		density: 0.5,
		hardness: 0.5,
		previewing: false,
		setWarpActive: (warpActive) =>
			set(
				warpActive
					? { warpActive }
					: {
							warpActive,
							previewing: false,
						},
			),
		toggleWarp: () =>
			set((s) =>
				s.warpActive
					? {
							warpActive: false,
							previewing: false,
						}
					: { warpActive: true },
			),
		setTool: (tool) => set({ tool }),
		setSize: (size) => set({ size: clamp(size, 0.02, 0.6) }),
		setPressure: (pressure) => set({ pressure: clamp(pressure, 0, 1) }),
		setRate: (rate) => set({ rate: clamp(rate, 0, 1) }),
		setDensity: (density) => set({ density: clamp(density, 0, 1) }),
		setHardness: (hardness) => set({ hardness: clamp(hardness, 0, 1) }),
		setPreviewing: (previewing) => set({ previewing }),
	}));
	return _store;
}
function warpStore() {
	if (!_store) throw new Error("[image-warp] store used before activate()");
	return _store;
}
function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
//#endregion
//#region src/warp-stage.ts
const STAGE_ID = "com.safelight.image-warp.warp";
const FIELD_KEY = "warpField";
const WARP_GLSL = `
if (warpEnabled > 0.5) {
  srcUv = clamp(srcUv + texture(warpField, srcUv).rg, 0.0, 1.0);
}
`;
function buildStage() {
	return {
		id: STAGE_ID,
		name: "Image Warp",
		phase: "geometry",
		priority: 50,
		uniforms: [
			{
				key: "warpEnabled",
				glslType: "float",
				default: 0,
			},
		],
		textures: [
			{
				key: FIELD_KEY,
				kind: "dynamic",
				width: 256,
				height: 256,
				format: "rgba16f",
			},
		],
		glsl: WARP_GLSL,
	};
}
/** Qualified paramBag key for the enable uniform (what setDynParam expects). */
const ENABLED_PARAM = `${STAGE_ID}.warpEnabled`;
/** Descriptor-less paramBag key carrying the persisted field revision token.
 *  Not a declared uniform, so it never binds to GLSL, but it round-trips through
 *  the sidecar JSON and participates in undo/redo for free. */
const FIELD_REV_PARAM = `${STAGE_ID}.fieldRev`;
//#endregion
//#region src/field.ts
const N = 256;
const COUNT = N * N;
const field = new Float32Array(COUNT * 4);
let texVersion = 1;
let empty = true;
function getField() {
	return field;
}
function isEmpty() {
	return empty;
}
function clear() {
	field.fill(0);
	empty = true;
}
/** Replace the whole field from a decoded buffer (length COUNT*4). */
function setFrom(buf) {
	if (buf.length === field.length) field.set(buf);
	else {
		field.fill(0);
		field.set(buf.subarray(0, Math.min(buf.length, field.length)));
	}
	empty = false;
}
/** Upload the current field to the GPU (debounce/coalesce at the call site). */
function push() {
	api().setStageTexture(STAGE_ID, FIELD_KEY, {
		data: field,
		width: N,
		height: N,
		format: "rgba16f",
		version: ++texVersion,
	});
}
const TWIRL_K = 5;
const PUCKER_K = 10;
const RELAX_K = 8;
const TURB_K = 0.6;
let turbSeed = 1;
function reseedTurbulence() {
	turbSeed = (turbSeed * 1664525 + 1013904223) >>> 0;
}
function hash2(x, y, s) {
	let h = (x * 374761393 + y * 668265263 + s * 2246822519) >>> 0;
	h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(u, v, s) {
	const N = 8;
	const fx = u * N;
	const fy = v * N;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fx - x0;
	const ty = fy - y0;
	const a = hash2(x0, y0, s);
	const b = hash2(x0 + 1, y0, s);
	const c = hash2(x0, y0 + 1, s);
	const d = hash2(x0 + 1, y0 + 1, s);
	const sx = tx * tx * (3 - 2 * tx);
	const sy = ty * ty * (3 - 2 * ty);
	return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function stamp(o) {
	const { tool, cu, cv, rv, aspect, hardness, density, pressure } = o;
	if (rv <= 0) return;
	const rU = rv / aspect;
	const rV = rv;
	const gx0 = Math.max(0, Math.floor((cu - rU) * N));
	const gx1 = Math.min(N - 1, Math.ceil((cu + rU) * N));
	const gy0 = Math.max(0, Math.floor((cv - rV) * N));
	const gy1 = Math.min(N - 1, Math.ceil((cv + rV) * N));
	if (gx1 < gx0 || gy1 < gy0) return;
	const twirlSign = tool === "twirl-cw" ? 1 : -1;
	let touched = false;
	for (let gy = gy0; gy <= gy1; gy++) {
		const gv = (gy + 0.5) / N;
		const ry = gv - cv;
		for (let gx = gx0; gx <= gx1; gx++) {
			const gu = (gx + 0.5) / N;
			const rx = (gu - cu) * aspect;
			const dist = Math.sqrt(rx * rx + ry * ry) / rv;
			if (dist > 1) continue;
			const fall = 1 - smoothstep(hardness, 1, dist);
			if (fall <= 0) continue;
			const idx = (gy * N + gx) * 4;
			const freeze = field[idx + 2];
			if (tool === "freeze") {
				field[idx + 2] = clamp01(
					freeze + fall * density * Math.max(o.flow, 0.04),
				);
				touched = true;
				continue;
			}
			if (tool === "thaw") {
				field[idx + 2] = clamp01(
					freeze - fall * density * Math.max(o.flow, 0.04),
				);
				touched = true;
				continue;
			}
			const w = fall * density * pressure * (1 - freeze);
			if (w <= 0) continue;
			switch (tool) {
				case "push":
					field[idx] += -o.dirU * w;
					field[idx + 1] += -o.dirV * w;
					break;
				case "turbulence": {
					const k = w * o.flow * TURB_K;
					field[idx] += (noise(gu, gv, turbSeed) - 0.5) * k;
					field[idx + 1] += (noise(gu, gv, turbSeed ^ 2654435769) - 0.5) * k;
					break;
				}
				case "twirl-cw":
				case "twirl-ccw": {
					const ang = twirlSign * w * o.flow * TWIRL_K;
					const c = Math.cos(ang);
					const s = Math.sin(ang);
					const nrx = rx * c - ry * s;
					const nry = rx * s + ry * c;
					field[idx] += (nrx - rx) / aspect;
					field[idx + 1] += nry - ry;
					break;
				}
				case "pucker": {
					const k = w * o.flow * PUCKER_K;
					field[idx] += (gu - cu) * k;
					field[idx + 1] += (gv - cv) * k;
					break;
				}
				case "bloat": {
					const k = w * o.flow * PUCKER_K;
					field[idx] += (cu - gu) * k;
					field[idx + 1] += (cv - gv) * k;
					break;
				}
				case "reconstruct": {
					const k = clamp01(w * o.flow * RELAX_K);
					field[idx] += (0 - field[idx]) * k;
					field[idx + 1] += (0 - field[idx + 1]) * k;
					break;
				}
				case "smooth": {
					const k = clamp01(w * o.flow * RELAX_K);
					const au = avg(gx, gy, 0);
					const av = avg(gx, gy, 1);
					field[idx] += (au - field[idx]) * k;
					field[idx + 1] += (av - field[idx + 1]) * k;
					break;
				}
			}
			touched = true;
		}
	}
	if (touched) empty = false;
}
function avg(gx, gy, ch) {
	let sum = 0;
	let n = 0;
	for (let dy = -1; dy <= 1; dy++) {
		const y = gy + dy;
		if (y < 0 || y >= N) continue;
		for (let dx = -1; dx <= 1; dx++) {
			const x = gx + dx;
			if (x < 0 || x >= N) continue;
			sum += field[(y * N + x) * 4 + ch];
			n++;
		}
	}
	return n ? sum / n : 0;
}
function smoothstep(e0, e1, x) {
	if (e0 === e1) return x < e0 ? 0 : 1;
	const t = clamp01((x - e0) / (e1 - e0));
	return t * t * (3 - 2 * t);
}
function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
const MAGIC = 1230459472;
const HEADER = 12;
function serialize(rev) {
	const out = new Uint8Array(393228);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, MAGIC, false);
	out[4] = 1;
	out[5] = 3;
	dv.setUint16(6, N, true);
	dv.setUint32(8, rev >>> 0, true);
	let o = HEADER;
	for (let i = 0; i < COUNT; i++) {
		const s = i * 4;
		dv.setUint16(o, f32ToF16(field[s]), true);
		o += 2;
		dv.setUint16(o, f32ToF16(field[s + 1]), true);
		o += 2;
		dv.setUint16(o, f32ToF16(field[s + 2]), true);
		o += 2;
	}
	return out;
}
/** Decode a serialized field, or null if the bytes aren't a field of this size. */
function parse(bytes) {
	if (bytes.length < HEADER) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, false) !== MAGIC) return null;
	if (bytes[4] !== 1 || bytes[5] !== 3) return null;
	if (dv.getUint16(6, true) !== N) return null;
	const rev = dv.getUint32(8, true);
	if (bytes.length < 393228) return null;
	const buf = new Float32Array(COUNT * 4);
	let o = HEADER;
	for (let i = 0; i < COUNT; i++) {
		const s = i * 4;
		buf[s] = f16ToF32(dv.getUint16(o, true));
		o += 2;
		buf[s + 1] = f16ToF32(dv.getUint16(o, true));
		o += 2;
		buf[s + 2] = f16ToF32(dv.getUint16(o, true));
		o += 2;
	}
	return {
		rev,
		buf,
	};
}
const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
function f32ToF16(val) {
	f32[0] = val;
	const x = i32[0];
	const sign = (x >> 16) & 32768;
	let exp = ((x >> 23) & 255) - 127 + 15;
	let mant = x & 8388607;
	if (exp <= 0) {
		if (exp < -10) return sign;
		mant |= 8388608;
		const shift = 14 - exp;
		return sign | ((mant + (1 << (shift - 1))) >> shift);
	}
	if (exp >= 31) return sign | 31744;
	const half = (mant + 4096) >> 13;
	if (half & 1024) return sign | ((exp + 1) << 10);
	return sign | (exp << 10) | half;
}
function f16ToF32(h) {
	const sign = (h & 32768) << 16;
	const exp = (h >> 10) & 31;
	const mant = h & 1023;
	if (exp === 0) {
		if (mant === 0) {
			i32[0] = sign;
			return f32[0];
		}
		let e = -1;
		let m = mant;
		do {
			e++;
			m <<= 1;
		} while ((m & 1024) === 0);
		m &= 1023;
		i32[0] = sign | ((112 - e) << 23) | (m << 13);
		return f32[0];
	}
	if (exp === 31) {
		i32[0] = sign | 2139095040 | (mant << 13);
		return f32[0];
	}
	i32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
	return f32[0];
}
//#endregion
//#region src/persistence.ts
const MEMO_MAX = 64;
const memo = /* @__PURE__ */ new Map();
let revCounter = 0;
/** Last (photoId, rev) we've reflected into the live field — guards the
 *  subscription from reloading a state we already show (e.g. our own commit). */
let appliedKey = "";
function devStore() {
	return api().stores.useDevelopStore;
}
function currentRev() {
	const v = devStore().getState().paramBag[FIELD_REV_PARAM];
	return typeof v === "number" ? v : 0;
}
function memoSet(key, buf) {
	memo.set(key, buf);
	if (memo.size > MEMO_MAX) {
		const oldest = memo.keys().next().value;
		if (oldest !== void 0) memo.delete(oldest);
	}
}
/** Commit the current field as a new revision: store it, point the photo at it,
 *  and checkpoint history. Call at the end of a stroke (or a panel action). */
async function commit(label) {
	const photoId = devStore().getState().photoId;
	if (!photoId) return;
	const rev = ++revCounter;
	const key = `${photoId}:${rev}`;
	memoSet(key, getField().slice());
	appliedKey = key;
	api().develop.putPhotoData("warpField", serialize(rev));
	devStore()
		.getState()
		.setDynParams({
			[FIELD_REV_PARAM]: rev,
			[ENABLED_PARAM]: isEmpty() ? 0 : 1,
		});
	await devStore().getState().commitEdit(label);
}
/** Wipe the warp on the current photo and checkpoint it. */
async function clearWarp() {
	const photoId = devStore().getState().photoId;
	if (!photoId) return;
	clear();
	push();
	const rev = ++revCounter;
	appliedKey = `${photoId}:${rev}`;
	memoSet(appliedKey, getField().slice());
	api().develop.putPhotoData("warpField", null);
	devStore()
		.getState()
		.setDynParams({
			[FIELD_REV_PARAM]: rev,
			[ENABLED_PARAM]: 0,
		});
	await devStore().getState().commitEdit("Clear Warp");
}
/** Reflect the current photo + its fieldRev into the live field + GPU texture.
 *  Idempotent; safe to call often. */
function sync() {
	const photoId = devStore().getState().photoId;
	if (!photoId) {
		clear();
		push();
		appliedKey = "";
		return;
	}
	const rev = currentRev();
	const key = `${photoId}:${rev}`;
	if (key === appliedKey) return;
	if (rev === 0) {
		clear();
		push();
		appliedKey = key;
		return;
	}
	revCounter = Math.max(revCounter, rev);
	const cached = memo.get(key);
	if (cached) {
		setFrom(cached);
		push();
		appliedKey = key;
		return;
	}
	appliedKey = key;
	api()
		.develop.getPhotoData("warpField")
		.then((bytes) => {
			if (devStore().getState().photoId !== photoId || currentRev() !== rev)
				return;
			const parsed = bytes ? parse(bytes) : null;
			if (parsed && parsed.rev === rev) {
				memoSet(key, parsed.buf.slice());
				setFrom(parsed.buf);
			} else clear();
			push();
		});
}
/** Subscribe to develop-store changes; resync whenever the photo or its
 *  fieldRev token changes (photo switch, undo, redo, preset, reload). */
function subscribe() {
	let lastPhoto = devStore().getState().photoId;
	let lastRev = currentRev();
	return devStore().subscribe((s) => {
		const rev =
			typeof s.paramBag[FIELD_REV_PARAM] === "number"
				? s.paramBag[FIELD_REV_PARAM]
				: 0;
		if (s.photoId === lastPhoto && rev === lastRev) return;
		lastPhoto = s.photoId;
		lastRev = rev;
		sync();
	});
}
//#endregion
//#region src/keys.ts
const BRUSH = {
	"brush.smaller": {
		def: "[",
		alts: [],
		apply: () => step("size", -0.02),
	},
	"brush.larger": {
		def: "]",
		alts: [],
		apply: () => step("size", 0.02),
	},
	"brush.featherDown": {
		def: "Shift+[",
		alts: ["Shift+{"],
		apply: () => step("hardness", 0.05),
	},
	"brush.featherUp": {
		def: "Shift+]",
		alts: ["Shift+}"],
		apply: () => step("hardness", -0.05),
	},
	"brush.opacityDown": {
		def: ",",
		alts: [],
		apply: () => step("density", -0.1),
	},
	"brush.opacityUp": {
		def: ".",
		alts: [],
		apply: () => step("density", 0.1),
	},
	"brush.flowDown": {
		def: "Shift+,",
		alts: ["Shift+<"],
		apply: () => step("rate", -0.1),
	},
	"brush.flowUp": {
		def: "Shift+.",
		alts: ["Shift+>"],
		apply: () => step("rate", 0.1),
	},
};
function step(field, delta) {
	const s = warpStore().getState();
	if (field === "size") s.setSize(s.size + delta);
	else if (field === "hardness") s.setHardness(s.hardness + delta);
	else if (field === "density") s.setDensity(s.density + delta);
	else s.setRate(s.rate + delta);
}
function comboFromEvent(e) {
	const k = e.key;
	if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta")
		return null;
	const parts = [];
	if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
	if (e.shiftKey) parts.push("Shift");
	if (e.altKey) parts.push("Alt");
	parts.push(k.length === 1 ? k.toUpperCase() : k);
	return parts.join("+");
}
function isEditableTarget(t) {
	if (!(t instanceof HTMLElement)) return false;
	if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)
		return true;
	if (t instanceof HTMLInputElement)
		return ![
			"range",
			"checkbox",
			"radio",
			"button",
			"color",
			"file",
			"submit",
			"reset",
		].includes(t.type);
	return t.isContentEditable;
}
function inDevelop$1() {
	const detached = new URLSearchParams(window.location.search).get("detached");
	return (
		api().stores.useUIStore.getState().activeModule === "develop" ||
		detached === "develop"
	);
}
function initWarpKeys() {
	const handler = (e) => {
		if (!warpStore().getState().warpActive || !inDevelop$1()) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopImmediatePropagation();
			warpStore().getState().setWarpActive(false);
			return;
		}
		if (isEditableTarget(e.target)) return;
		const combo = comboFromEvent(e);
		if (!combo) return;
		for (const [id, b] of Object.entries(BRUSH)) {
			const bound = api().keybindings.getBinding(id);
			if (combo === bound || (bound === b.def && b.alts.includes(combo))) {
				e.preventDefault();
				b.apply(1);
				return;
			}
		}
	};
	window.addEventListener("keydown", handler, true);
	return () => window.removeEventListener("keydown", handler, true);
}
//#endregion
//#region src/Overlay.ts
function WarpOverlay() {
	const react = R();
	const store = warpStore();
	const warpActive = store((s) => s.warpActive);
	const size = store((s) => s.size);
	const hardness = store((s) => s.hardness);
	const previewing = store((s) => s.previewing);
	const dev = api().stores.useDevelopStore;
	const cropping = dev((s) => s.cropping);
	const activeTool = dev((s) => s.activeTool);
	const photoId = dev((s) => s.photoId);
	const fieldRev = dev((s) => s.paramBag[FIELD_REV_PARAM]);
	const { rect, imageRect, nonce, toImage, radiusToScreen } =
		api().develop.useDevelopOverlay();
	const rootRef = react.useRef(null);
	const ringRef = react.useRef(null);
	const innerRingRef = react.useRef(null);
	const freezeRef = react.useRef(null);
	const pressed = react.useRef(false);
	const raf = react.useRef(0);
	const cur = react.useRef({
		lx: 0,
		ly: 0,
		u: 0,
		v: 0,
		inside: false,
	});
	const lastDab = react.useRef({
		u: 0,
		v: 0,
	});
	const lastTime = react.useRef(0);
	const shown = react.useRef(false);
	const visible =
		warpActive &&
		!cropping &&
		activeTool === "none" &&
		!!rect &&
		!!photoId &&
		!!toImage;
	react.useEffect(() => {
		if (!visible) return;
		return api().develop.setCanvasCursor("none", { priority: 20 });
	}, [visible]);
	react.useEffect(() => {
		if (visible) return;
		pressed.current = false;
		if (raf.current) cancelAnimationFrame(raf.current);
		raf.current = 0;
	}, [visible]);
	const aspect = imageRect && imageRect.h > 0 ? imageRect.w / imageRect.h : 1;
	const paintFreeze = () => {
		const el = freezeRef.current;
		if (!el) return;
		if (el.width !== 256) {
			el.width = 256;
			el.height = 256;
		}
		const ctx = el.getContext("2d");
		if (!ctx) return;
		const img = ctx.createImageData(256, 256);
		const f = getField();
		for (let i = 0; i < 256 * 256; i++) {
			const fr = f[i * 4 + 2];
			const a = fr < 0 ? 0 : fr > 1 ? 1 : fr;
			const o = i * 4;
			img.data[o] = 235;
			img.data[o + 1] = 35;
			img.data[o + 2] = 35;
			img.data[o + 3] = Math.round(a * 125);
		}
		ctx.putImageData(img, 0, 0);
	};
	react.useEffect(() => {
		if (!visible) return;
		const id = requestAnimationFrame(paintFreeze);
		return () => cancelAnimationFrame(id);
	}, [visible, nonce, fieldRev]);
	const updateRing = (lx, ly, show) => {
		shown.current = show;
		const s = store.getState();
		const px = radiusToScreen ? radiusToScreen(s.size) : 20;
		const place = (el, d, vis) => {
			if (!el) return;
			el.style.display = vis ? "block" : "none";
			el.style.width = `${d}px`;
			el.style.height = `${d}px`;
			el.style.left = `${lx}px`;
			el.style.top = `${ly}px`;
		};
		place(ringRef.current, px * 2, show);
		place(innerRingRef.current, px * 2 * s.hardness, show && s.hardness < 0.99);
	};
	react.useEffect(() => {
		if (shown.current) updateRing(cur.current.lx, cur.current.ly, true);
	}, [size, hardness]);
	const localFromEvent = (e) => {
		const root = rootRef.current;
		const r = root
			? root.getBoundingClientRect()
			: {
					left: 0,
					top: 0,
				};
		return {
			lx: e.clientX - r.left,
			ly: e.clientY - r.top,
		};
	};
	const sampleAt = (lx, ly) => {
		const p = toImage
			? toImage(lx, ly)
			: {
					x: -1,
					y: -1,
				};
		const inside = p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
		cur.current = {
			lx,
			ly,
			u: p.x,
			v: p.y,
			inside,
		};
	};
	const frame = (now) => {
		if (!pressed.current) return;
		const s = store.getState();
		const dt = Math.min(0.05, Math.max(0, (now - lastTime.current) / 1e3));
		lastTime.current = now;
		const c = cur.current;
		const last = lastDab.current;
		const rv = s.size;
		const spacing = Math.max(rv / 4, 0.002);
		const ddu = c.u - last.u;
		const ddv = c.v - last.v;
		const distH = Math.hypot(ddu * aspect, ddv);
		const nDabs = Math.max(1, Math.ceil(distH / spacing));
		const flowPer = s.tool === "push" ? 0 : (s.rate * dt) / nDabs;
		const dirU = ddu / nDabs;
		const dirV = ddv / nDabs;
		if (c.inside || last.u >= 0) {
			for (let i = 1; i <= nDabs; i++) {
				const t = i / nDabs;
				stamp({
					tool: s.tool,
					cu: last.u + ddu * t,
					cv: last.v + ddv * t,
					rv,
					aspect,
					hardness: s.hardness,
					density: s.density,
					pressure: s.pressure,
					flow: flowPer,
					dirU,
					dirV,
				});
			}
			lastDab.current = {
				u: c.u,
				v: c.v,
			};
			push();
			if (s.tool === "freeze" || s.tool === "thaw") paintFreeze();
		}
		raf.current = requestAnimationFrame(frame);
	};
	const onDown = (e) => {
		if (!visible) return;
		const { lx, ly } = localFromEvent(e);
		sampleAt(lx, ly);
		if (!cur.current.inside) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {}
		if (dev.getState().paramBag[ENABLED_PARAM] !== 1)
			dev.getState().setDynParam(ENABLED_PARAM, 1);
		if (store.getState().tool === "turbulence") reseedTurbulence();
		pressed.current = true;
		lastDab.current = {
			u: cur.current.u,
			v: cur.current.v,
		};
		lastTime.current = performance.now();
		updateRing(lx, ly, true);
		if (raf.current) cancelAnimationFrame(raf.current);
		raf.current = requestAnimationFrame(frame);
	};
	const onMove = (e) => {
		if (!visible) return;
		const { lx, ly } = localFromEvent(e);
		sampleAt(lx, ly);
		updateRing(lx, ly, true);
	};
	const onUp = (e) => {
		if (!pressed.current) return;
		pressed.current = false;
		if (raf.current) cancelAnimationFrame(raf.current);
		raf.current = 0;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {}
		if (!isEmpty()) commit("Warp");
	};
	const onLeave = () => {
		if (!pressed.current) updateRing(0, 0, false);
	};
	if (!visible) return null;
	return h(
		"div",
		{
			ref: rootRef,
			onPointerDown: onDown,
			onPointerMove: onMove,
			onPointerUp: onUp,
			onPointerLeave: onLeave,
			style: {
				position: "absolute",
				inset: 0,
				pointerEvents: "auto",
				touchAction: "none",
				cursor: "none",
				overflow: "hidden",
			},
		},
		imageRect
			? h("canvas", {
					ref: freezeRef,
					style: {
						position: "absolute",
						left: `${imageRect.x}px`,
						top: `${imageRect.y}px`,
						width: `${imageRect.w}px`,
						height: `${imageRect.h}px`,
						pointerEvents: "none",
					},
				})
			: null,
		h("div", {
			ref: ringRef,
			style: {
				position: "absolute",
				display: "none",
				transform: "translate(-50%, -50%)",
				borderRadius: "50%",
				border: "1.5px solid rgba(255,255,255,0.9)",
				boxShadow:
					"0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
				pointerEvents: "none",
			},
		}),
		h("div", {
			ref: innerRingRef,
			style: {
				position: "absolute",
				display: "none",
				transform: "translate(-50%, -50%)",
				borderRadius: "50%",
				border: "1.5px dashed rgba(255,255,255,0.9)",
				boxShadow:
					"0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
				pointerEvents: "none",
			},
		}),
		previewing && rect
			? centerPreview(
					rect,
					radiusToScreen ? radiusToScreen(size) : 20,
					hardness,
				)
			: null,
	);
}
function centerPreview(rect, px, hardness) {
	const cx = rect.x + rect.w / 2;
	const cy = rect.y + rect.h / 2;
	const ring = (d, dashed) =>
		h("div", {
			style: {
				position: "absolute",
				left: `${cx}px`,
				top: `${cy}px`,
				width: `${d}px`,
				height: `${d}px`,
				transform: "translate(-50%, -50%)",
				borderRadius: "50%",
				border: `1.5px ${dashed ? "dashed" : "solid"} rgba(255,255,255,0.9)`,
				boxShadow:
					"0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
				pointerEvents: "none",
			},
		});
	return h(
		"div",
		{
			style: {
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
			},
		},
		ring(px * 2, false),
		hardness < 0.99 ? ring(px * 2 * hardness, true) : null,
	);
}
//#endregion
//#region src/icons.ts
function svg(size, ...children) {
	return h(
		"svg",
		{
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": true,
		},
		...children,
	);
}
const PATHS = {
	push: ["M5 12 h11", "M12 8 l5 4 l-5 4"],
	"twirl-cw": ["M12 4 a8 8 0 1 1 -7 4", "M5 8 l0 -4 l4 0"],
	"twirl-ccw": ["M12 4 a8 8 0 1 0 7 4", "M19 8 l0 -4 l-4 0"],
	pucker: ["M5 5 l5 5", "M19 5 l-5 5", "M5 19 l5 -5", "M19 19 l-5 -5"],
	bloat: ["M10 10 l-5 -5", "M14 10 l5 -5", "M10 14 l-5 5", "M14 14 l5 5"],
	turbulence: [
		"M3 9 C 6 5, 9 13, 12 9 S 18 5, 21 9",
		"M3 15 C 6 11, 9 19, 12 15 S 18 11, 21 15",
	],
	reconstruct: ["M5 12 a7 7 0 1 1 2 5", "M5 17 l0 -4 l4 0"],
	smooth: ["M4 14 C 8 8, 12 8, 16 14 S 20 16, 20 13"],
	freeze: ["M12 4 v16", "M5 8 l14 8", "M19 8 l-14 8"],
	thaw: ["M12 6 v8", "M9 11 l3 3 l3 -3", "M6 19 h12"],
};
function toolIcon(tool, size = 16) {
	return svg(
		size,
		...PATHS[tool].map((d) =>
			h("path", {
				key: d,
				d,
			}),
		),
	);
}
//#endregion
//#region src/Panel.ts
const TOOLS = [
	{
		id: "push",
		label: "Push",
	},
	{
		id: "reconstruct",
		label: "Restore",
	},
	{
		id: "twirl-cw",
		label: "Twirl CW",
	},
	{
		id: "twirl-ccw",
		label: "Twirl CCW",
	},
	{
		id: "pucker",
		label: "Pucker",
	},
	{
		id: "bloat",
		label: "Bloat",
	},
	{
		id: "turbulence",
		label: "Turbulence",
	},
	{
		id: "smooth",
		label: "Smooth",
	},
	{
		id: "freeze",
		label: "Freeze",
	},
	{
		id: "thaw",
		label: "Thaw",
	},
];
const BTN = (extra) => ({
	height: "28px",
	borderRadius: "5px",
	border: "1px solid var(--color-border-subtle)",
	background: "var(--color-surface-2, transparent)",
	color: "var(--color-text-secondary)",
	cursor: "pointer",
	fontSize: "11px",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	gap: "6px",
	...extra,
});
function WarpPanel() {
	const react = R();
	const store = warpStore();
	const Slider = api().components.Slider;
	const warpActive = store((s) => s.warpActive);
	const tool = store((s) => s.tool);
	const size = store((s) => s.size);
	const density = store((s) => s.density);
	const pressure = store((s) => s.pressure);
	const rate = store((s) => s.rate);
	const hardness = store((s) => s.hardness);
	if (!warpActive)
		return h(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "8px",
					padding: "8px",
				},
			},
			h(
				"button",
				{
					onClick: () => store.getState().setWarpActive(true),
					style: BTN({
						background: "var(--color-accent)",
						borderColor: "var(--color-accent)",
						color: "var(--color-on-accent, #fff)",
					}),
				},
				h(
					"span",
					{
						style: {
							fontSize: "14px",
							lineHeight: 1,
						},
					},
					"✎",
				),
				"Warp",
			),
			h(
				"button",
				{
					onClick: () => void clearWarp(),
					style: BTN({}),
				},
				"Clear warp",
			),
		);
	const toolButton = (t) => {
		const selected = tool === t.id;
		return h(
			"button",
			{
				key: t.id,
				onClick: () => store.getState().setTool(t.id),
				title: t.label,
				style: {
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: "3px",
					padding: "6px 2px",
					borderRadius: "5px",
					border: "1px solid",
					borderColor: selected
						? "var(--color-accent)"
						: "var(--color-border-subtle)",
					background: selected
						? "var(--color-accent)"
						: "var(--color-surface-2, transparent)",
					color: selected
						? "var(--color-on-accent, #fff)"
						: "var(--color-text-secondary)",
					cursor: "pointer",
					fontSize: "9.5px",
					lineHeight: 1,
				},
			},
			toolIcon(t.id, 17),
			h("span", null, t.label),
		);
	};
	const slider = (label, value, min, max, dflt, onChange) =>
		react.createElement(Slider, {
			label,
			value,
			min,
			max,
			step: 0.01,
			defaultValue: dflt,
			onChange: (v) => {
				onChange(v);
				store.getState().setPreviewing(true);
			},
			onCommit: () => store.getState().setPreviewing(false),
		});
	return h(
		"div",
		{
			style: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				padding: "8px",
			},
		},
		h(
			"div",
			{
				style: {
					fontSize: "10.5px",
					color: "var(--color-accent)",
					lineHeight: 1.4,
				},
			},
			"Drag on the image to warp.",
		),
		h(
			"div",
			{
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(2, 1fr)",
					gap: "4px",
				},
			},
			...TOOLS.map(toolButton),
		),
		h("div", {
			style: {
				height: "1px",
				background: "var(--color-border-subtle)",
				margin: "2px 0",
			},
		}),
		slider("Size", size, 0.02, 0.6, 0.14, (v) => store.getState().setSize(v)),
		slider("Density", density, 0, 1, 0.5, (v) =>
			store.getState().setDensity(v),
		),
		slider("Pressure", pressure, 0, 1, 1, (v) =>
			store.getState().setPressure(v),
		),
		slider("Rate", rate, 0, 1, 0.5, (v) => store.getState().setRate(v)),
		slider("Hardness", hardness, 0, 1, 0.5, (v) =>
			store.getState().setHardness(v),
		),
		h(
			"button",
			{
				onClick: () => store.getState().setWarpActive(false),
				style: BTN({ marginTop: "4px" }),
			},
			"Done",
		),
	);
}
//#endregion
//#region src/index.ts
const ID = "com.safelight.image-warp";
const TOGGLE_ACTION = `${ID}.toggle`;
let unsubscribe = null;
let unbindKeys = null;
function inDevelop(api) {
	const detached = new URLSearchParams(window.location.search).get("detached");
	return (
		(api.stores.useUIStore.getState().activeModule === "develop" ||
			detached === "develop") &&
		!!api.stores.useDevelopStore.getState().photoId
	);
}
function activate(api) {
	initRuntime(api);
	initStore();
	api.registerProcessingStage(buildStage());
	clear();
	push();
	sync();
	unsubscribe = subscribe();
	unbindKeys = initWarpKeys();
	api.registerKeybinding({
		id: TOGGLE_ACTION,
		label: "Image Warp",
		category: "Develop",
		defaultCombo: "Shift+W",
		handler: () => {
			if (inDevelop(api)) warpStore().getState().toggleWarp();
		},
	});
	api.registerSlot({
		id: `${ID}.overlay`,
		slot: "develop-canvas-overlay",
		component: WarpOverlay,
		order: 40,
	});
	api.registerPanel({
		id: `${ID}.panel`,
		title: "Warp",
		component: WarpPanel,
		defaultDock: {
			module: "develop",
			direction: "right",
			order: 7,
			width: 250,
		},
		onReset: () => {
			clearWarp();
		},
	});
}
function deactivate() {
	unsubscribe?.();
	unsubscribe = null;
	unbindKeys?.();
	unbindKeys = null;
	try {
		const api$1 = api();
		api$1.setStageTexture(STAGE_ID, FIELD_KEY, null);
		api$1.unregisterProcessingStage(STAGE_ID);
	} catch {}
}
//#endregion
export { activate, deactivate };
