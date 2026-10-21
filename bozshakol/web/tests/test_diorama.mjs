// Проверка переноса координат в схему (web/diorama.js) на настоящем модуле.
//   node bozshakol/web/tests/test_diorama.mjs                       — узлы и рёбра geometry.json
//   node bozshakol/web/tests/test_diorama.mjs http://127.0.0.1:8095 — плюс текущие x, y всех двойников стенда
// Условия: каждый узел встаёт на своё место из core/diorama.json и внутрь макета; точка на ребре дороги —
// на схематичной дороге с той же долей пути; любые x, y двойников — внутри макета; самосвал на дороге — на линии.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDiorama } from '../diorama.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..', '..', 'core');
const geometry = JSON.parse(readFileSync(path.join(core, 'geometry.json'), 'utf8'));
const D = JSON.parse(readFileSync(path.join(core, 'diorama.json'), 'utf8'));
class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const terrainStub = { groundAt: () => 0 };
const dio = createDiorama({ Vector3 }, geometry, terrainStub, D);
const B = dio.bounds;
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('ОШИБКА', msg); } };
const inside = ([x, y]) => x >= B.minX && x <= B.maxX && y >= B.minY && y <= B.maxY;
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return { d: Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t), t };
};
const onSchemaRoad = (p) => Math.min(...dio.edges.map((e) => segDist(p, e.sa, e.sb).d));

// 1. узлы — на своих местах и внутри макета
for (const [n, r] of Object.entries(geometry.nodes)) {
  const s = dio.mapXY(r[0], r[1]);
  ok(inside(s), `узел ${n} вне макета: ${s}`);
  ok(Math.hypot(s[0] - D.nodes[n][0], s[1] - D.nodes[n][1]) < 0.01, `узел ${n}: ${s} вместо ${D.nodes[n]}`);
}
// 2. точки на рёбрах — на схематичной дороге с той же долей пути
for (const e of dio.edges) {
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const x = e.ra[0] + (e.rb[0] - e.ra[0]) * t, y = e.ra[1] + (e.rb[1] - e.ra[1]) * t;
    const s = dio.mapXY(x, y), q = segDist(s, e.sa, e.sb);
    ok(onSchemaRoad(s) < 0.01, `${e.from}–${e.to} t=${t}: точка не на дороге (${onSchemaRoad(s).toFixed(3)})`);
    ok(inside(s), `${e.from}–${e.to} t=${t}: вне макета`);
    if (q.d < 0.01) ok(Math.abs(q.t - t) < 0.01, `${e.from}–${e.to}: доля пути ${q.t.toFixed(3)} вместо ${t}`);
  }
}
// 2б. дорога нигде не уходит под поверхность схемы (самосвал не «тонет» на выезде из карьера)
for (const e of dio.edges) {
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, x = e.ra[0] + (e.rb[0] - e.ra[0]) * t, y = e.ra[1] + (e.rb[1] - e.ra[1]) * t, z = e.ra[2] + (e.rb[2] - e.ra[2]) * t;
    const p = dio.toScene(x, y, z), surf = dio.surfaceAt(p.x, -p.z);
    ok(p.y >= surf - 0.3, `${e.from}–${e.to} t=${t.toFixed(2)}: дорога ниже поверхности на ${(surf - p.y).toFixed(2)}`);
  }
}
// 3. сетка реальных точек вокруг рудника — внутри макета
for (let x = -6000; x <= 5000; x += 250) for (let y = -4000; y <= 3000; y += 250) ok(inside(dio.mapXY(x, y)), `точка ${x}, ${y} вне макета`);

// 4. двойники стенда
const url = process.argv[2];
if (url) {
  const r = await fetch(url.replace(/\/$/, '') + '/ditto/api/2/search/things?namespaces=kz.bozshakol&option=size(200)&fields=thingId,features');
  const items = (await r.json()).items || [];
  let n = 0, trucks = 0;
  for (const t of items) {
    const f = t.features || {}, x = f.x && f.x.properties && f.x.properties.value, y = f.y && f.y.properties && f.y.properties.value;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    n++;
    const s = dio.mapXY(x, y);
    ok(inside(s), `${t.thingId} (${x}, ${y}) вне макета: ${s}`);
    if (t.thingId.includes(':truck-')) {
      const ne = dio.nearestEdge(x, y);
      if (ne && ne.d < 1) { trucks++; ok(onSchemaRoad(s) < 0.05, `${t.thingId} на дороге в жизни, но не на дороге схемы (${onSchemaRoad(s).toFixed(2)})`); }
    }
  }
  console.log(`двойников с x, y: ${n}, самосвалов на дорогах: ${trucks}`);
}
console.log(fails ? `ПРОВАЛ: ${fails} из ${checks}` : `всё в порядке: ${checks} проверок`);
process.exitCode = fails ? 1 : 0;
