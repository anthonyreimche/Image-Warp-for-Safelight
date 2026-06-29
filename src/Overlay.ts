// The interactive layer. Mounted into the click-through "develop-canvas-overlay"
// slot, it covers the whole canvas; while the warp tool is armed it captures
// pointer events, maps them to source-UV via api.develop's overlay helpers
// (getBoundingClientRect — never offsetX/Y, which break under Windows display
// scaling), and stamps the active tool into the displacement field on a rAF loop
// so a held or dragged brush flows smoothly. A custom brush ring tracks the
// cursor; the native cursor is hidden while armed.
//
// Inline styles + CSS variables (no Tailwind in runtime extensions).

import { h, R, api } from "./runtime";
import { warpStore } from "./store";
import { ENABLED_PARAM, FIELD_REV_PARAM, FIELD_SIZE } from "./warp-stage";
import * as field from "./field";
import { commit } from "./persistence";

export function WarpOverlay() {
  const react = R();
  const store = warpStore();
  const warpActive: boolean = store((s) => s.warpActive);
  // Selected so the rings re-render when size/hardness change via keys or
  // sliders (not just on cursor move), and to drive the centred preview.
  const size: number = store((s) => s.size);
  const hardness: number = store((s) => s.hardness);
  const previewing: boolean = store((s) => s.previewing);

  // While a pan/zoom gesture key (Ctrl/⌘ or Space) is held, the overlay turns
  // click-through so the pointer drives the canvas pan/zoom underneath instead of
  // painting — mirroring the built-in mask/heal overlay (see ViewportImage). The
  // ref tracks the live value for pointer handlers; the state drives re-render.
  const [gesture, setGesture] = react.useState(false);
  const gestureRef = react.useRef(false);
  const setGestureState = (v: boolean) => {
    gestureRef.current = v;
    setGesture(v);
  };

  const dev = api().stores.useDevelopStore;
  const cropping: boolean = dev((s) => s.cropping);
  const activeTool: string = dev((s) => s.activeTool);
  const photoId: string | null = dev((s) => s.photoId);
  // Re-render (and repaint the freeze overlay) when the warp revision changes
  // via undo/redo/photo-load.
  const fieldRev = dev((s: { paramBag: Record<string, unknown> }) => s.paramBag[FIELD_REV_PARAM]);

  const ov = api().develop.useDevelopOverlay();
  const { rect, imageRect, nonce, toImage, radiusToScreen } = ov;

  const rootRef = react.useRef(null);
  const ringRef = react.useRef(null);
  const innerRingRef = react.useRef(null);
  const freezeRef = react.useRef(null);
  const pressed = react.useRef(false);
  const raf = react.useRef(0);
  const cur = react.useRef({ lx: 0, ly: 0, u: 0, v: 0, inside: false });
  const lastDab = react.useRef({ u: 0, v: 0 });
  const lastTime = react.useRef(0);
  const shown = react.useRef(false);

  const visible =
    warpActive && !cropping && activeTool === "none" && !!rect && !!photoId && !!toImage;

  // Hide the native cursor while armed so only our brush ring shows. Released
  // while a pan/zoom gesture is held so ViewportImage's zoom/pan cursor surfaces.
  react.useEffect(() => {
    if (!visible || gesture) return;
    const release = api().develop.setCanvasCursor("none", { priority: 20 });
    return release;
  }, [visible, gesture]);

  // Track the pan/zoom gesture keys while armed. Mirrors ViewportImage: Ctrl/⌘ or
  // Space held → click-through (canvas pans/zooms); released → back to painting.
  react.useEffect(() => {
    if (!visible) {
      setGestureState(false);
      return;
    }
    const isEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.code === "Space" || e.ctrlKey || e.metaKey) setGestureState(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || !(e.ctrlKey || e.metaKey)) setGestureState(false);
    };
    const onBlur = () => setGestureState(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      setGestureState(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Tear down any in-flight stroke if we become hidden mid-drag.
  react.useEffect(() => {
    if (visible) return;
    pressed.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, [visible]);

  const aspect = imageRect && imageRect.h > 0 ? imageRect.w / imageRect.h : 1;

  // Red wash over frozen texels so you can see what's protected while warping.
  const paintFreeze = () => {
    const el = freezeRef.current as HTMLCanvasElement | null;
    if (!el) return;
    if (el.width !== FIELD_SIZE) {
      el.width = FIELD_SIZE;
      el.height = FIELD_SIZE;
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(FIELD_SIZE, FIELD_SIZE);
    const f = field.getField();
    for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i++) {
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

  // Repaint on (re)show, view change, and undo/redo/photo-load. rAF so the
  // canvas exists and is laid out first.
  react.useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(paintFreeze);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, nonce, fieldRev]);

  const updateRing = (lx: number, ly: number, show: boolean) => {
    shown.current = show;
    const s = store.getState();
    const px = radiusToScreen ? radiusToScreen(s.size) : 20;
    const place = (el: HTMLDivElement | null, d: number, vis: boolean) => {
      if (!el) return;
      el.style.display = vis ? "block" : "none";
      el.style.width = `${d}px`;
      el.style.height = `${d}px`;
      el.style.left = `${lx}px`;
      el.style.top = `${ly}px`;
    };
    place(ringRef.current as HTMLDivElement | null, px * 2, show);
    // Dashed inner ring marks the hard core (hardness), matching the preview.
    place(innerRingRef.current as HTMLDivElement | null, px * 2 * s.hardness, show && s.hardness < 0.99);
  };

  // Resize the cursor ring the instant the brush size/hardness change via
  // keys/sliders, not only on the next pointer move.
  react.useEffect(() => {
    if (shown.current) updateRing(cur.current.lx, cur.current.ly, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, hardness]);

  // Entering pan/zoom mode: abandon any in-flight stroke (committing what's there)
  // and hide the brush ring so the overlay visibly hands off to the canvas.
  react.useEffect(() => {
    if (!gesture) return;
    if (pressed.current) {
      pressed.current = false;
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      if (!field.isEmpty()) void commit("Warp");
    }
    updateRing(0, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture]);

  const localFromEvent = (e: PointerEvent): { lx: number; ly: number } => {
    const root = rootRef.current as HTMLElement | null;
    const r = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
    return { lx: e.clientX - r.left, ly: e.clientY - r.top };
  };

  const sampleAt = (lx: number, ly: number) => {
    const p = toImage ? toImage(lx, ly) : { x: -1, y: -1 };
    const inside = p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
    cur.current = { lx, ly, u: p.x, v: p.y, inside };
  };

  const frame = (now: number) => {
    if (!pressed.current) return;
    const s = store.getState();
    const dt = Math.min(0.05, Math.max(0, (now - lastTime.current) / 1000));
    lastTime.current = now;

    const c = cur.current;
    const last = lastDab.current;
    const rv = s.size;
    const spacing = Math.max(rv / 4, 0.002);
    const ddu = c.u - last.u;
    const ddv = c.v - last.v;
    const distH = Math.hypot(ddu * aspect, ddv);
    const nDabs = Math.max(1, Math.ceil(distH / spacing));
    const isMotion = s.tool === "push";
    const flowPer = isMotion ? 0 : (s.rate * dt) / nDabs;
    const dirU = ddu / nDabs;
    const dirV = ddv / nDabs;

    if (c.inside || last.u >= 0) {
      for (let i = 1; i <= nDabs; i++) {
        const t = i / nDabs;
        field.stamp({
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
      lastDab.current = { u: c.u, v: c.v };
      field.push();
      if (s.tool === "freeze" || s.tool === "thaw") paintFreeze();
    }
    raf.current = requestAnimationFrame(frame);
  };

  const onDown = (e: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!visible || gestureRef.current) return;
    const { lx, ly } = localFromEvent(e);
    sampleAt(lx, ly);
    if (!cur.current.inside) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    // Arm the GPU stage so the in-progress field renders live (committed later).
    if (dev.getState().paramBag[ENABLED_PARAM] !== 1)
      dev.getState().setDynParam(ENABLED_PARAM, 1);
    if (store.getState().tool === "turbulence") field.reseedTurbulence();
    pressed.current = true;
    lastDab.current = { u: cur.current.u, v: cur.current.v };
    lastTime.current = performance.now();
    updateRing(lx, ly, true);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(frame);
  };

  const onMove = (e: PointerEvent) => {
    if (!visible || gestureRef.current) return;
    const { lx, ly } = localFromEvent(e);
    sampleAt(lx, ly);
    updateRing(lx, ly, true);
  };

  const onUp = (e: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!pressed.current) return;
    pressed.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    if (!field.isEmpty()) void commit("Warp");
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
        // Click-through while a pan/zoom gesture key is held so the pointer
        // reaches the canvas pan/zoom layer underneath instead of painting.
        pointerEvents: gesture ? "none" : "auto",
        touchAction: "none",
        cursor: gesture ? "default" : "none",
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
        boxShadow: "0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
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
        boxShadow: "0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
        pointerEvents: "none",
      },
    }),
    previewing && rect ? centerPreview(rect, radiusToScreen ? radiusToScreen(size) : 20, hardness) : null,
  );
}

// Centred reference ring shown while a brush slider is dragged: outer = size,
// dashed inner = the hard core (hardness).
function centerPreview(
  rect: { x: number; y: number; w: number; h: number },
  px: number,
  hardness: number,
): unknown {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const ring = (d: number, dashed: boolean) =>
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
        boxShadow: "0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
        pointerEvents: "none",
      },
    });
  return h(
    "div",
    { style: { position: "absolute", inset: 0, pointerEvents: "none" } },
    ring(px * 2, false),
    hardness < 0.99 ? ring(px * 2 * hardness, true) : null,
  );
}
