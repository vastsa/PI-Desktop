/*
 * Chart helpers for model-written visualization fragments (ADR
 * gen-ui-inline-visualization). Loaded in the shell <head> right after the
 * bundled D3, so a fragment script can call `viz.*` and `d3.*` directly.
 *
 * They own the boilerplate every chart would otherwise repeat: sizing the SVG
 * from its container and redrawing on width or theme changes, theme-aware
 * axes with titles, width-aware tick counts, and tick-label overlap pruning.
 * Keeping it here lets the model write only the chart-specific marks.
 */
(() => {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const charts = new Set();
  const DEFAULT_MARGIN = { top: 16, right: 20, bottom: 48, left: 64 };

  const resolveElement = (target) => {
    const element =
      typeof target === "string" ? document.getElementById(target.replace(/^#/, "")) : target;
    if (!(element instanceof Element)) throw new Error(`viz: no element ${String(target)}`);
    return element;
  };

  /** Resolve a theme variable (`"--primary"` or `"primary"`) for canvas or chart APIs. */
  const color = (name) =>
    getComputedStyle(root).getPropertyValue(name.startsWith("--") ? name : `--${name}`).trim();

  /** CSS color for persistent series identity `index` (0-based, wraps after 6). */
  const series = (index) => `var(--viz-series-${(((index % 6) + 6) % 6) + 1})`;

  const defaultHeight = (width) => Math.round(Math.min(420, Math.max(240, width * 0.56)));

  /**
   * Mount a responsive SVG chart in `target` (an element or its id) and call
   * `draw({ svg, width, height, compact, reducedMotion })`. The SVG's viewBox
   * always matches the container's measured width. The first draw runs right
   * after the calling script finishes; `draw` reruns when the width or theme
   * changes, and synchronously whenever the caller invokes `redraw()`.
   * The SVG is emptied before each draw unless `options.keep` is true.
   */
  function chart(target, draw, options = {}) {
    const container = resolveElement(target);
    const svg = d3.select(container).append("svg").attr("role", "img");
    if (options.label) svg.attr("aria-label", options.label);
    let lastWidth = 0;
    let frame = 0;
    const render = () => {
      frame = 0;
      const width = Math.floor(container.clientWidth);
      if (width <= 0) return;
      lastWidth = width;
      const height =
        typeof options.height === "function"
          ? options.height(width)
          : (options.height ?? defaultHeight(width));
      svg.attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);
      if (!options.keep) svg.selectAll("*").remove();
      draw({ svg, width, height, compact: width < 480, reducedMotion: reducedMotion.matches });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    const observer = new ResizeObserver(() => {
      if (Math.floor(container.clientWidth) !== lastWidth) schedule();
    });
    observer.observe(container);
    const handle = {
      svg,
      redraw: render,
      destroy() {
        observer.disconnect();
        charts.delete(handle);
      },
    };
    charts.add(handle);
    // First draw runs once the fragment script finishes, so state declared or
    // computed after the `viz.chart` call is ready; `redraw()` stays synchronous.
    queueMicrotask(() => {
      if (charts.has(handle) && lastWidth === 0) render();
    });
    return handle;
  }

  /**
   * Translate a plot group inside `svg` by `margin` (merged over the default,
   * which reserves 64px for the y axis) and return the inner plot size.
   */
  function plot(svg, width, height, margin = {}) {
    const m = { ...DEFAULT_MARGIN, ...margin };
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    return {
      g,
      margin: m,
      innerWidth: Math.max(0, width - m.left - m.right),
      innerHeight: Math.max(0, height - m.top - m.bottom),
    };
  }

  /** Domain from all observations with relative `pad` on each side; `zero` keeps 0 in view. */
  function extent(values, accessor = (value) => value, { pad = 0.05, zero = false } = {}) {
    let [min, max] = d3.extent(values, accessor);
    if (min == null || max == null) return [0, 1];
    if (zero) {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    if (min === max) return [min - 1, max + 1];
    const span = (max - min) * pad;
    return [zero && min === 0 ? 0 : min - span, zero && max === 0 ? 0 : max + span];
  }

  /** Elements of a D3 selection, an array or NodeList of elements or selections, or one element. */
  const elementsOf = (labels) => {
    if (!labels) return [];
    if (typeof labels.nodes === "function") return labels.nodes();
    if (typeof labels.length === "number") {
      return Array.from(labels, (item) => (item && typeof item.node === "function" ? item.node() : item));
    }
    return [labels];
  };

  /**
   * Hide labels in document order that would sit within `gap` px of the
   * previous visible one. Accepts a D3 selection, an array or NodeList, or a
   * single element.
   */
  function pruneOverlaps(labels, gap = 4, vertical = false) {
    let previous = null;
    for (const label of elementsOf(labels)) {
      if (!label || typeof label.getBoundingClientRect !== "function") continue;
      label.removeAttribute("visibility");
      const box = label.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (previous) {
        const overlap = vertical
          ? box.bottom + gap > previous.top && box.top - gap < previous.bottom
          : box.left - gap < previous.right && box.right + gap > previous.left;
        if (overlap) {
          label.setAttribute("visibility", "hidden");
          continue;
        }
      }
      previous = box;
    }
  }

  /** Keep the first and last x tick labels inside the plot by anchoring them inward. */
  function anchorEdgeLabels(axisGroup, innerWidth) {
    const ticks = axisGroup.selectAll(".tick text").nodes();
    if (ticks.length === 0) return;
    const frame = axisGroup.node().getBoundingClientRect();
    for (const node of [ticks[0], ticks.at(-1)]) {
      const box = node.getBoundingClientRect();
      if (box.left < frame.left - 1) node.setAttribute("text-anchor", "start");
      else if (box.right > frame.left + innerWidth + 1) node.setAttribute("text-anchor", "end");
    }
  }

  /**
   * Draw bottom and left axes for `x` / `y` scales into the plot group `g`:
   * width-aware tick counts (at most four x ticks below 400px), axis titles,
   * optional horizontal grid lines, inward edge labels, and overlap pruning.
   */
  function axes(g, options) {
    const { x, y, innerWidth, innerHeight, xLabel, yLabel, xFormat, yFormat, grid = false } = options;
    const xTicks = options.xTicks ?? Math.max(2, Math.min(innerWidth < 400 ? 4 : 10, Math.floor(innerWidth / 80)));
    const yTicks = options.yTicks ?? Math.max(2, Math.min(8, Math.floor(innerHeight / 48)));
    const result = {};
    if (x) {
      const axis = d3.axisBottom(x).tickSizeOuter(0);
      if (typeof x.ticks === "function") axis.ticks(xTicks);
      if (xFormat) axis.tickFormat(xFormat);
      const group = g.append("g").attr("class", "viz-axis viz-axis-x").attr("transform", `translate(0,${innerHeight})`).call(axis);
      anchorEdgeLabels(group, innerWidth);
      pruneOverlaps(group.selectAll(".tick text"));
      if (xLabel) {
        g.append("text").attr("class", "viz-axis-title").attr("x", innerWidth / 2).attr("y", innerHeight + 40).attr("text-anchor", "middle").text(xLabel);
      }
      result.x = group;
    }
    if (y) {
      const axis = d3.axisLeft(y).tickSizeOuter(0);
      if (typeof y.ticks === "function") axis.ticks(yTicks);
      if (yFormat) axis.tickFormat(yFormat);
      if (grid) {
        g.append("g").attr("class", "viz-gridlines").call(d3.axisLeft(y).ticks(yTicks).tickSize(-innerWidth).tickFormat(() => "")).call((sel) => sel.select(".domain").remove());
      }
      const group = g.append("g").attr("class", "viz-axis viz-axis-y").call(axis);
      pruneOverlaps(group.selectAll(".tick text"), 2, true);
      if (yLabel) {
        g.append("text").attr("class", "viz-axis-title").attr("transform", "rotate(-90)").attr("x", -innerHeight / 2).attr("y", -48).attr("text-anchor", "middle").text(yLabel);
      }
      result.y = group;
    }
    return result;
  }

  /** Transition duration that honors `prefers-reduced-motion`. */
  const duration = (ms = 250) => (reducedMotion.matches ? 0 : ms);

  const accessor = (field) => (typeof field === "function" ? field : (d) => d[field]);

  /** Least-squares fit of `y` on `x` (fields or accessors) → `{ slope, intercept, r, n }`, or null. */
  function regression(data, x, y) {
    const getX = accessor(x);
    const getY = accessor(y);
    const points = data
      .map((d) => [Number(getX(d)), Number(getY(d))])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (points.length < 2) return null;
    const meanX = d3.mean(points, (p) => p[0]);
    const meanY = d3.mean(points, (p) => p[1]);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const [a, b] of points) {
      sxy += (a - meanX) * (b - meanY);
      sxx += (a - meanX) ** 2;
      syy += (b - meanY) ** 2;
    }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    return { slope, intercept: meanY - slope * meanX, r: syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy), n: points.length };
  }

  // ---- Declarative charts: `viz.render(target, spec)` ----------------------
  // Common charts are described, not drawn: the spec names the mark and which
  // fields map to x / y / color, and the helpers derive scales, axes, legend,
  // tooltips, and value labels. Custom visuals keep using `viz.chart`.

  const isDateLike = (v) =>
    v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)));
  const keyOf = (v) => (v instanceof Date ? +v : v);
  const uniq = (values) => [...new Map(values.map((v) => [keyOf(v), v])).values()];
  const normalize = (enc) => (enc == null ? null : typeof enc === "object" ? enc : { field: enc });

  function inferType(values) {
    if (values.length > 0 && values.every((v) => typeof v === "number" && Number.isFinite(v))) return "linear";
    if (values.length > 0 && values.every(isDateLike)) return "time";
    return "band";
  }

  function formatter(format, type) {
    if (typeof format === "function") return format;
    if (typeof format === "string") return type === "time" ? d3.timeFormat(format) : d3.format(format);
    if (type === "time") {
      return (v) => d3.timeFormat(v.getHours() || v.getMinutes() ? "%m-%d %H:%M" : "%Y-%m-%d")(v);
    }
    return (v) =>
      typeof v === "number" ? d3.format(Number.isInteger(v) ? "," : ",.2~f")(v) : String(v ?? "");
  }

  /** Resolve one channel (`"field"` or `{ field, title, type, format, domain }`) against the data. */
  function channel(input, data) {
    const enc = normalize(input);
    if (!enc) return null;
    const read = accessor(enc.field);
    const type = enc.type ?? inferType(data.map(read));
    const get = type === "time" ? (d) => new Date(read(d)) : read;
    let tick = enc.format ? formatter(enc.format, type) : undefined;
    if (!tick && type === "time") {
      // D3's default multi-scale time ticks mix "November" with "2026"; use one numeric format instead.
      const [lo, hi] = d3.extent(data, get);
      const days = lo && hi ? (hi - lo) / 864e5 : 0;
      tick = d3.timeFormat(days > 730 ? "%Y" : days > 60 ? "%Y-%m" : days > 2 ? "%m-%d" : "%H:%M");
    }
    return {
      ...enc,
      type,
      get,
      title: enc.title ?? (typeof enc.field === "string" ? enc.field : ""),
      fmt: formatter(enc.format, type),
      tick,
    };
  }

  /** Rough rendered width of category labels, for the left margin of band y axes. */
  const labelWidth = (values, fmt) =>
    d3.max(values, (v) => [...fmt(v)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0)) ?? 0;

  function continuous(ch, values, range, zero) {
    if (ch.type === "time") return d3.scaleTime(ch.domain ?? d3.extent(values), range);
    if (ch.type === "band") return d3.scalePoint(ch.domain ?? uniq(values), range).padding(0.5);
    return d3.scaleLinear(ch.domain ?? extent(values, (v) => v, { zero }), range);
  }

  function setLegend(legend, items, ramp) {
    legend.replaceChildren();
    legend.hidden = !items && !ramp;
    for (const item of items ?? []) {
      const entry = document.createElement("span");
      entry.className = "viz-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "viz-legend-swatch";
      swatch.style.background = item.color;
      entry.append(swatch, item.label);
      legend.append(entry);
    }
    if (ramp) {
      const entry = document.createElement("span");
      entry.className = "viz-legend-item";
      const bar = document.createElement("span");
      bar.className = "viz-legend-ramp";
      entry.append(ramp.min, bar, ramp.max);
      legend.append(entry);
    }
  }

  const tip = (s, d, parts) => (s.tooltip ? String(s.tooltip(d)) : parts.filter(Boolean).join(" · "));
  const part = (ch, value) => (ch ? `${ch.title ? `${ch.title}: ` : ""}${ch.fmt(value)}` : "");

  function drawBars(g, s, w, h, compact) {
    const horizontal = s.y.type === "band" && s.x.type !== "band";
    const cat = horizontal ? s.y : s.x;
    const val = horizontal ? s.x : s.y;
    const cats = cat.domain ?? uniq(s.data.map(cat.get));
    const c = d3.scaleBand(cats, horizontal ? [0, h] : [0, w]).padding(0.2);
    const grouped = s.keys.length > 1 && !s.stack;
    const sub = d3.scaleBand(grouped ? s.keys : ["all"], [0, c.bandwidth()]).padding(0.06);
    let layers = null;
    let values = s.data.map(val.get);
    if (s.keys.length > 1 && s.stack) {
      const index = new Map(cats.map((k, i) => [keyOf(k), i]));
      const rows = cats.map((k) => Object.fromEntries([["__cat", k], ...s.keys.map((key) => [key, 0])]));
      for (const d of s.data) {
        const row = rows[index.get(keyOf(cat.get(d)))];
        if (row) row[s.seriesOf(d)] += Number(val.get(d)) || 0;
      }
      layers = d3.stack().keys(s.keys)(rows);
      values = layers.flatMap((layer) => layer.flatMap((p) => [p[0], p[1]]));
    }
    const v = d3.scaleLinear(val.domain ?? extent(values, (x) => x, { zero: true }), horizontal ? [0, w] : [h, 0]);
    const [lo, hi] = v.domain();
    const base = v(Math.max(lo, Math.min(0, hi)));
    const place = (rect, pos, thick, a, b) =>
      horizontal
        ? rect.attr("y", pos).attr("height", thick).attr("x", Math.min(a, b)).attr("width", Math.abs(b - a))
        : rect.attr("x", pos).attr("width", thick).attr("y", Math.min(a, b)).attr("height", Math.abs(b - a));
    axes(g, {
      x: horizontal ? v : c,
      y: horizontal ? c : v,
      innerWidth: w,
      innerHeight: h,
      xLabel: horizontal ? val.title : cat.title,
      yLabel: horizontal ? undefined : val.title,
      xFormat: horizontal ? val.tick : cat.tick,
      yFormat: horizontal ? cat.tick : val.tick,
      grid: !horizontal,
    });
    const marks = g.append("g");
    if (layers) {
      layers.forEach((layer, i) => {
        for (const p of layer) {
          place(marks.append("rect"), c(p.data.__cat), c.bandwidth(), v(p[0]), v(p[1]))
            .style("fill", series(i))
            .attr("data-tooltip", tip(s, p.data, [cat.fmt(p.data.__cat), `${layer.key}: ${val.fmt(p[1] - p[0])}`]));
        }
      });
      return;
    }
    const labels = [];
    for (const d of s.data) {
      const key = s.seriesOf ? s.seriesOf(d) : "all";
      const pos = c(cat.get(d));
      if (pos === undefined) continue;
      const at = pos + (grouped ? sub(key) : 0);
      const thick = grouped ? sub.bandwidth() : c.bandwidth();
      const end = v(val.get(d));
      place(marks.append("rect"), at, thick, base, end)
        .style("fill", s.seriesOf ? s.colorOf(key) : series(0))
        .attr("data-tooltip", tip(s, d, [cat.fmt(cat.get(d)), s.seriesOf ? String(key) : "", part(val, val.get(d))]));
      const showLabels = s.labels ?? (!grouped && s.data.length <= (compact ? 8 : 16));
      if (showLabels) {
        const label = marks.append("text").attr("class", "viz-value").text(val.fmt(val.get(d)));
        if (horizontal) label.attr("x", Math.max(end, base) + 4).attr("y", at + thick / 2).attr("dy", "0.35em");
        else label.attr("x", at + thick / 2).attr("y", Math.min(end, base) - 4).attr("text-anchor", "middle");
        labels.push(label.node());
      }
    }
    if (!horizontal) pruneOverlaps(labels);
  }

  function drawXY(g, s, w, h) {
    const area = s.mark === "area";
    const stacked = area && s.keys.length > 1 && s.stack !== false;
    const groups = s.seriesOf ? d3.group(s.data, s.seriesOf) : new Map([["all", s.data]]);
    const x = continuous(s.x, s.data.map(s.x.get), [0, w], false);
    let rows = null;
    let layers = null;
    let yValues = s.data.map(s.y.get);
    if (stacked) {
      const xs = uniq(s.data.map(s.x.get));
      const index = new Map(xs.map((k, i) => [keyOf(k), i]));
      rows = xs.map((k) => Object.fromEntries([["__x", k], ...s.keys.map((key) => [key, 0])]));
      for (const d of s.data) rows[index.get(keyOf(s.x.get(d)))][s.seriesOf(d)] += Number(s.y.get(d)) || 0;
      if (s.x.type !== "band") rows.sort((a, b) => a.__x - b.__x);
      layers = d3.stack().keys(s.keys)(rows);
      yValues = layers.flatMap((layer) => layer.flatMap((p) => [p[0], p[1]]));
    }
    const y = continuous({ ...s.y, type: "linear" }, yValues, [h, 0], area || s.y.zero);
    axes(g, {
      x,
      y,
      innerWidth: w,
      innerHeight: h,
      xLabel: s.x.title,
      yLabel: s.y.title,
      xFormat: s.x.tick,
      yFormat: s.y.tick,
      grid: true,
    });
    const marks = g.append("g");
    if (s.mark === "point") {
      const size = s.size ? channel(s.size, s.data) : null;
      const r = size ? d3.scaleSqrt(d3.extent(s.data, size.get), [3, 14]) : () => 4;
      for (const d of s.data) {
        const key = s.seriesOf ? s.seriesOf(d) : "all";
        marks
          .append("circle")
          .attr("cx", x(s.x.get(d)))
          .attr("cy", y(s.y.get(d)))
          .attr("r", size ? r(size.get(d)) : 4)
          .style("fill", s.seriesOf ? s.colorOf(key) : series(0))
          .style("fill-opacity", 0.75)
          .attr("data-tooltip", tip(s, d, [s.seriesOf ? String(key) : "", part(s.x, s.x.get(d)), part(s.y, s.y.get(d)), size ? part(size, size.get(d)) : ""]));
      }
      const fit = s.trend && s.x.type !== "band" ? regression(s.data, (d) => +s.x.get(d), s.y.get) : null;
      if (fit) {
        const [x0, x1] = x.domain().map(Number);
        marks
          .append("line")
          .attr("class", "viz-trend")
          .attr("x1", x(x0))
          .attr("x2", x(x1))
          .attr("y1", y(fit.intercept + fit.slope * x0))
          .attr("y2", y(fit.intercept + fit.slope * x1));
      }
      return;
    }
    const order = (list) => (s.x.type === "band" ? list : [...list].sort((a, b) => s.x.get(a) - s.x.get(b)));
    if (stacked) {
      layers.forEach((layer, i) => {
        marks
          .append("path")
          .datum(layer)
          .style("fill", series(i))
          .style("fill-opacity", 0.7)
          .attr("d", d3.area((p) => x(p.data.__x), (p) => y(p[0]), (p) => y(p[1])));
      });
    }
    let i = 0;
    for (const [key, list] of groups) {
      const color = s.seriesOf ? s.colorOf(key) : series(i);
      const points = order(list);
      if (area && !stacked) {
        marks
          .append("path")
          .datum(points)
          .style("fill", color)
          .style("fill-opacity", 0.18)
          .attr("d", d3.area((d) => x(s.x.get(d)), y(Math.max(y.domain()[0], 0)), (d) => y(s.y.get(d))));
      }
      if (!stacked) {
        marks
          .append("path")
          .datum(points)
          .style("fill", "none")
          .style("stroke", color)
          .style("stroke-width", 2)
          .attr("d", d3.line((d) => x(s.x.get(d)), (d) => y(s.y.get(d))));
      }
      for (const d of points) {
        const cy = stacked
          ? y(layers[s.keys.indexOf(key)].find((p) => keyOf(p.data.__x) === keyOf(s.x.get(d)))?.[1] ?? 0)
          : y(s.y.get(d));
        if (!stacked && points.length <= 40) {
          marks.append("circle").attr("cx", x(s.x.get(d))).attr("cy", cy).attr("r", 3).style("fill", color);
        }
        marks
          .append("circle")
          .attr("cx", x(s.x.get(d)))
          .attr("cy", cy)
          .attr("r", 10)
          .style("fill", "transparent")
          .attr("data-tooltip", tip(s, d, [s.seriesOf ? String(key) : "", part(s.x, s.x.get(d)), part(s.y, s.y.get(d))]));
      }
      i += 1;
    }
  }

  function drawHeatmap(g, s, w, h, legend) {
    const xs = s.x.domain ?? uniq(s.data.map(s.x.get));
    const ys = s.y.domain ?? uniq(s.data.map(s.y.get));
    const x = d3.scaleBand(xs, [0, w]).padding(0.04);
    const y = d3.scaleBand(ys, [0, h]).padding(0.04);
    const value = s.value;
    const [min, max] = value.domain ?? d3.extent(s.data, value.get);
    const opacity = d3.scaleLinear([min ?? 0, max ?? 1], [0.08, 1]).clamp(true);
    axes(g, { x, y, innerWidth: w, innerHeight: h, xLabel: s.x.title, xFormat: s.x.tick, yFormat: s.y.tick });
    const marks = g.append("g");
    for (const d of s.data) {
      marks
        .append("rect")
        .attr("x", x(s.x.get(d)))
        .attr("y", y(s.y.get(d)))
        .attr("width", x.bandwidth())
        .attr("height", y.bandwidth())
        .attr("rx", 2)
        .style("fill", series(0))
        .style("fill-opacity", opacity(value.get(d)))
        .attr("data-tooltip", tip(s, d, [s.x.fmt(s.x.get(d)), s.y.fmt(s.y.get(d)), part(value, value.get(d))]));
    }
    setLegend(legend, null, { min: value.fmt(min ?? 0), max: value.fmt(max ?? 0) });
  }

  function drawArc(svg, s, width, height, legend) {
    const total = d3.sum(s.data, s.theta.get);
    const radius = Math.max(0, Math.min(width, height) / 2 - 8);
    const g = svg.append("g").attr("transform", `translate(${width / 2},${height / 2})`);
    const arcs = d3.pie().sort(null).value(s.theta.get)(s.data);
    const shape = d3.arc().innerRadius(radius * 0.6).outerRadius(radius).padAngle(0.01);
    const pct = (v) => (total ? d3.format(".1%")(v / total) : "");
    arcs.forEach((a, i) => {
      const key = s.seriesOf ? s.seriesOf(a.data) : String(i);
      g.append("path")
        .attr("d", shape(a))
        .style("fill", s.seriesOf ? s.colorOf(key) : series(i))
        .attr("data-tooltip", tip(s, a.data, [String(key), `${s.theta.fmt(s.theta.get(a.data))} (${pct(s.theta.get(a.data))})`]));
    });
    if (s.center !== false) {
      g.append("text").attr("class", "viz-value").attr("text-anchor", "middle").attr("dy", "0.35em").text(s.center ?? s.theta.fmt(total));
    }
    setLegend(
      legend,
      arcs.map((a, i) => {
        const key = s.seriesOf ? s.seriesOf(a.data) : String(i);
        return { label: `${key} ${pct(s.theta.get(a.data))}`, color: s.seriesOf ? s.colorOf(key) : series(i) };
      }),
    );
  }

  const MARKS = new Set(["bar", "line", "area", "point", "heatmap", "arc"]);

  function drawSpec({ svg, width, height, compact }, spec, legend) {
    if (!MARKS.has(spec.mark)) throw new Error(`viz.render: unknown mark ${JSON.stringify(spec.mark)}`);
    const data = Array.isArray(spec.data) ? spec.data : [];
    const s = { ...spec, data };
    const color = spec.mark === "heatmap" ? null : channel(spec.color, data);
    s.seriesOf = color ? (d) => String(color.get(d)) : null;
    s.keys = color ? uniq(data.map(s.seriesOf)) : [];
    s.colorOf = (key) => series(Math.max(0, s.keys.indexOf(key)));
    setLegend(legend, s.keys.length > 1 && spec.mark !== "arc" ? s.keys.map((key) => ({ label: key, color: s.colorOf(key) })) : null);
    if (spec.mark === "arc") {
      s.theta = channel(spec.theta ?? spec.y ?? spec.value, data);
      drawArc(svg, s, width, height, legend);
      return;
    }
    s.x = channel(spec.x, data);
    s.y = channel(spec.y, data);
    if (!s.x || !s.y) throw new Error(`viz.render: mark ${spec.mark} needs x and y`);
    if (spec.mark === "heatmap") {
      s.x = { ...s.x, type: "band" };
      s.y = { ...s.y, type: "band" };
      s.value = channel(spec.value ?? spec.color, data);
    }
    const bandY = s.y.type === "band";
    const left = bandY ? Math.min(Math.round(width * 0.35), Math.max(40, 16 + labelWidth(uniq(data.map(s.y.get)), s.y.fmt))) : undefined;
    const { g, innerWidth, innerHeight } = plot(svg, width, height, left === undefined ? {} : { left });
    if (spec.mark === "bar") drawBars(g, s, innerWidth, innerHeight, compact);
    else if (spec.mark === "heatmap") drawHeatmap(g, s, innerWidth, innerHeight, legend);
    else drawXY(g, s, innerWidth, innerHeight);
  }

  /**
   * Draw a standard chart from a declarative spec and return
   * `{ update(patch), redraw, destroy, svg }`. `update` merges `patch` (or the
   * result of `patch(spec)`) into the spec and redraws, for controls.
   */
  function render(target, initial) {
    const container = resolveElement(target);
    let spec = { ...initial };
    const legend = document.createElement("div");
    legend.className = "viz-legend";
    legend.hidden = true;
    container.append(legend);
    const height = (width) =>
      typeof spec.height === "function"
        ? spec.height(width)
        : (spec.height ?? (spec.mark === "arc" ? Math.min(320, Math.max(220, width * 0.5)) : defaultHeight(width)));
    const handle = chart(container, (ctx) => drawSpec(ctx, spec, legend), { label: spec.label ?? spec.title, height });
    return {
      svg: handle.svg,
      redraw: handle.redraw,
      destroy: handle.destroy,
      update(patch) {
        spec = { ...spec, ...(typeof patch === "function" ? patch(spec) : patch) };
        handle.redraw();
      },
    };
  }

  // Theme updates rewrite the root's inline style; redraw charts once per frame
  // so canvas colors and anything resolved through `viz.color` stay current.
  let themeFrame = 0;
  new MutationObserver(() => {
    if (themeFrame) return;
    themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      for (const handle of charts) handle.redraw();
    });
  }).observe(root, { attributes: true, attributeFilter: ["style"] });

  window.viz = Object.freeze({
    render,
    chart,
    plot,
    axes,
    extent,
    regression,
    pruneOverlaps,
    color,
    series,
    duration,
  });
})();
