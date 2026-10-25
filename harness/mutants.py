import json, subprocess, shutil, sys, os, re
R='/tmp/c-red-final'
C='src/client.ts'; A='src/attribution.ts'; W='src/wire.ts'; K='src/cache.ts'; T='src/types.ts'; RK='src/rank.ts'
MERGE_LOOP="""    if (inner.has(e.collection)) continue;
    inner.set(e.collection, e);
    out.push(e);"""
SORT="out.sort((a, b) => cmp(a.dataset, b.dataset) || cmp(a.collection, b.collection))"
FILTER="prefix === undefined || inCollection(record.value, prefix)"
COLLOF="inCollection(value, collectionPrefix(e.dataset, e.collection))"
GP_CACHE="attribution: copyAttribution(cached.attribution ?? []) }"
ITEMS="return t.records.map((record) => ({ record, attribution: t.attribution }));"
M={
'M1':[(C,ITEMS,"return t.records.map((record) => ({ record, attribution }));")],
'M2':[(C,"""    } catch (error) {
      return fail("decode", error);""","""    } catch (error) {
      try { const b = JSON.parse(text); (this as any).leak = [...((this as any).leak ?? []), ...(readAttributionList(b?.attribution) ?? [])]; } catch {}
      return fail("decode", error);"""),
      (C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution([...used.map((u) => loaded.get(u)!.attribution), (this as any).leak]); (this as any).leak = undefined;"),
      (C,'import { readPlace,','import { readAttributionList, readPlace,')],
'M3a-across':[(A,MERGE_LOOP,"""    if (inner.has(e.collection)) { const i = out.indexOf(inner.get(e.collection)!); out[i] = e; inner.set(e.collection, e); continue; }
    inner.set(e.collection, e);
    out.push(e);""")],
'M4a':[(A,MERGE_LOOP.replace("inner.has(e.collection)","seen.has(e.dataset + ':' + e.collection)").replace("inner.set(e.collection, e);","seen.set(e.dataset + ':' + e.collection, new Map());"),
        MERGE_LOOP.replace("inner.has(e.collection)","seen.has(e.dataset + ':' + e.collection)").replace("inner.set(e.collection, e);","seen.set(e.dataset + ':' + e.collection, new Map());"))],
'M5':[(C,GP_CACHE,"attribution: mergeAttribution([cached.attribution ?? []]) }")],
'M6a':[(C,GP_CACHE,"attribution: cached.attribution && copyAttribution(cached.attribution) } as any")],
'M6b':[(C,"      attribution,\n    };","      attribution: attribution.length ? attribution : undefined as any,\n    };")],
'M7a':[(C,GP_CACHE,"attribution: cached.attribution ?? [] }")],
'M7b-noCopy':[(A,SORT+".map(copyEntry)",SORT)],
'M7b-shallow':[(A,SORT+".map(copyEntry)",SORT+".map((e) => ({ ...e }))")],
'M8':[(C,"""    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");
    validateRegion(options.region);""","""    validateRegion(options.region);
    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");""")],
'M9':[(C,"""    return readTileset(await this.transport.xrpc("org.atgeo.describeTileset", { slug }, options.signal));""","""    const m = ((this as any).ts ??= new Map()); if (m.has(slug)) return m.get(slug); const t = readTileset(await this.transport.xrpc("org.atgeo.describeTileset", { slug }, options.signal)); m.set(slug, t); return t;""")],
'M10':[(RK,"collection: collectionOf(value, attribution),","collection: collectionOf({ ...value, origin: recordKey(record) ?? undefined }, attribution),")],
'M11-shared':[(A,"`urn:atgeo:${dataset}:${collection}:`","`urn:atgeo:${dataset}:${collection}`")],
'M11-collOnly':[(A,COLLOF,"inCollection(value, collectionPrefix(e.dataset, e.collection).slice(0, -1))")],
'M12':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution([...((this.tiles as any).tiles as Map<string, any>).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, e]) => e.attribution));")],
'M13':[(C,"""    return {
      places: rank(records, region, query, sort),""","""    const places = rank(records, region, query, sort);
    const hitTiles = used.filter((u) => loaded.get(u)!.records.some((r) => places.some((p) => p.place === r.value)));
    const attribution2 = mergeAttribution(hitTiles.map((u) => loaded.get(u)!.attribution)).filter((e) => places.some((p) => p.collection?.dataset === e.dataset && p.collection?.collection === e.collection));
    return {
      places,"""),(C,"      attribution,\n    };","      attribution: attribution2,\n    };")],
'M14-locale':[(A,"const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);","const cmp = (x: string, y: string) => x.localeCompare(y);")],
'M14-ci':[(A,"const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);","const cmp = (x: string, y: string) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0);")],
'M15':[(A,"return { dataset: e.dataset, collection: e.collection };","return e;")],
'M16':[(RK,"collection: collectionOf(value, attribution),","...(collectionOf(value, attribution) ? { collection: collectionOf(value, attribution) } : {}),")],
'M17-sort':[(W,"  return out;\n}","  return out.sort((a, b) => (a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0));\n}")],
'M17-dedupe':[(W,"  return out;\n}","  return out.filter((e, i) => out.findIndex((f) => f.dataset === e.dataset && f.collection === e.collection) === i);\n}")],
'M17-keepUnkeyed':[(W,'if (!isObject(o) || typeof o.dataset !== "string" || typeof o.collection !== "string") continue;','if (!isObject(o) || (typeof o.dataset !== "string" && typeof o.collection !== "string")) continue;')],
'M18':[(W,"  if (!Array.isArray(v)) return undefined;\n  const out","  if (!Array.isArray(v)) return [];\n  const out")],
'M19':[(W,'if (!isObject(body.value)) return unusable("getPlace body has no value object");\n  return present({ value: freezePlace(body.value),','const v = isObject(body.value) ? body.value : body.record;\n  if (!isObject(v)) return unusable("getPlace body has no value object");\n  return present({ value: freezePlace(v),')],
'M20':[(W,"attribution: readAttributionList(body.attribution) ?? [] });","attribution: readAttributionList(body.attribution) as any });")],
'M21':[(C,"this.tiles.set(url, { records: outcome.records, attribution: outcome.attribution, size: outcome.size });","this.tiles.set(url, { records: outcome.records, size: outcome.size });")],
'M22':[(K,"return best && { record: best.record, attribution: best.attribution };","if (!best) return undefined; for (const [, entry] of this.tiles) if (entry.records.some((r) => recordKey(r) === key)) return { record: best.record, attribution: entry.attribution }; return undefined;")],
'M22-highest':[(K,"return best && { record: best.record, attribution: best.attribution };","if (!best) return undefined; let hi: any; for (const [url, entry] of this.tiles) if (entry.records.some((r) => recordKey(r) === key) && (!hi || url > hi.url)) hi = { url, a: entry.attribution }; return { record: best.record, attribution: hi.a };")],
'M23':[(C,'if (typeof (options as { dataset?: unknown }).dataset !== "string")','if ((options as { dataset?: unknown }).dataset === undefined)')],
'M24':[(C,'if (typeof (options as { dataset?: unknown }).dataset !== "string")','if (typeof (options as { dataset?: unknown }).dataset !== "string" || !options.dataset)')],
'M25':[(W,"  if (!Array.isArray(v)) return undefined;\n  const out","  if (v !== undefined && !Array.isArray(v)) throw new DecodingError('bad attribution');\n  if (!Array.isArray(v)) return undefined;\n  const out")],
'M26a-noMaxTiles':[(W,"    maxTiles: readInteger(body.maxTiles),\n","")],
'M26b-noOverview':[(W,"    overview: isObject(body.overview) ? present({ records: readInteger(body.overview.records) }) : undefined,\n","")],
'M26c-emptyOverviewDropped':[(W,"isObject(body.overview) ? present({ records: readInteger(body.overview.records) }) : undefined","isObject(body.overview) && readInteger(body.overview.records) !== undefined ? present({ records: readInteger(body.overview.records) }) : undefined")],
'M26d-negMaxTiles':[(W,"maxTiles: readInteger(body.maxTiles),","maxTiles: (readInteger(body.maxTiles) ?? -1) >= 0 ? readInteger(body.maxTiles) : undefined,")],
'M27':[(T,"  dataset: string;\n  collection?: string;\n  region: Region;","  dataset?: string;\n  collection?: string;\n  region: Region;"),(C,"const { dataset, collection } = options;","const { collection } = options; const dataset = options.dataset!;")],
'M28-uri':[(C,FILTER,"prefix === undefined || inCollection({ ...record.value, origin: recordKey(record) ?? undefined }, prefix)")],
'M28-offby1':[(C,FILTER,"prefix === undefined || inCollection(record.value, prefix.slice(0, -1))")],
'Y1':[(A,COLLOF,"typeof value.origin === 'string' && value.origin.includes(collectionPrefix(e.dataset, e.collection))")],
'Y2':[(C,FILTER,"prefix === undefined || (typeof record.value.origin === 'string' && record.value.origin.includes(prefix))")],
# new
'N1-listedOrderUnion':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution([...new Set(tileLists.flatMap((l) => l.tiles))].filter((u) => loaded.has(u)).map((u) => loaded.get(u)!.attribution));")],
'N2-licensesUndefinedKey':[(A,"({ ...e, ...(e.licenses && { licenses: [...e.licenses] }) })","({ ...e, licenses: e.licenses && [...e.licenses] })")],
'N3-sortDatasetOnly':[(A,SORT,"out.sort((a, b) => cmp(a.dataset, b.dataset))")],
'N4-sortJoinedColon':[(A,SORT,"out.sort((a, b) => cmp(a.dataset + ':' + a.collection, b.dataset + ':' + b.collection))")],
'N5-licensesAllOrNothing':[(W,"      licenses: readStrings(o.licenses),\n      attribution: readString(o.attribution),\n    }));","      licenses: Array.isArray(o.licenses) && o.licenses.every((s) => typeof s === 'string') ? (o.licenses as string[]) : undefined,\n      attribution: readString(o.attribution),\n    }));")],
'N6-strictEntry':[(W,'if (!isObject(o) || typeof o.dataset !== "string" || typeof o.collection !== "string") continue;','if (!isObject(o) || typeof o.dataset !== "string" || typeof o.collection !== "string") continue;\n    if (["release", "source", "attribution"].some((k) => o[k] !== undefined && typeof o[k] !== "string") || (o.licenses !== undefined && !Array.isArray(o.licenses))) continue;')],
'N8-lastCopyCollection':[(C,"const records = dedupe(","const lastAttr = new Map<string, any>(); for (const u of used) for (const r of loaded.get(u)!.records) { const k = typeof r.value.origin === 'string' ? r.value.origin : r.uri; if (k) lastAttr.set(k, loaded.get(u)!.attribution); }\n    const records0 = dedupe("),
  (C,"      .filter(({ record }) => inRegion(locate(record.value), region));","      .filter(({ record }) => inRegion(locate(record.value), region));\n    const records = records0.map((it) => { const k = typeof it.record.value.origin === 'string' ? it.record.value.origin : it.record.uri; return k ? { ...it, attribution: lastAttr.get(k) } : it; });")],
'N9-emptyCollectionFalsy':[(C,"const { dataset, collection } = options;","const { dataset } = options; const collection = options.collection || undefined;")],
'N11-matchSearchDatasetOnly':[(RK,"collection: collectionOf(value, attribution),","collection: collectionOf(value, attribution?.filter((e) => e.dataset === (globalThis as any).__ds)),"),(C,"const { dataset, collection } = options;","const { dataset, collection } = options; (globalThis as any).__ds = dataset;")],
'N12-unionSearchDatasetOnly':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution)).filter((e) => e.dataset === dataset);")],
'N13-unionInCompletionOrder':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution([...loaded.values()].map((t) => t.attribution));")],
'N14-netGetPlaceSorted':[(C,"return { origin, place: value, importance: importance ?? null, attribution };","return { origin, place: value, importance: importance ?? null, attribution: mergeAttribution([attribution]) };")],
'N15-collectionOfLastMatch':[(A,"""  for (const e of attribution ?? []) {
    if (""","""  for (const e of [...(attribution ?? [])].reverse()) {
    if (""")],
'N16-collectionFromSearchArgs':[(RK,"collection: collectionOf(value, attribution),","collection: (globalThis as any).__coll && collectionOf(value, attribution) ? { dataset: (globalThis as any).__ds2, collection: (globalThis as any).__coll } : collectionOf(value, attribution),"),(C,"const { dataset, collection } = options;","const { dataset, collection } = options; (globalThis as any).__ds2 = dataset; (globalThis as any).__coll = collection;")],
'N17-uriFallbackDatasetCheck':[(C,'if (typeof (options as { dataset?: unknown }).dataset !== "string")','if (typeof (options as { dataset?: unknown }).dataset !== "string" && (options as any).collection === undefined && (options as any).dataset == null)')],
'N18-cacheGetPlaceNoCopyLicenses':[(C,GP_CACHE,"attribution: (cached.attribution ?? []).map((e) => ({ ...e })) }")],
}
only=sys.argv[1:]
def run():
    p=subprocess.run(['npx','vitest','run','--reporter=json','--outputFile=/tmp/c-red-final/out.json'],cwd=R,capture_output=True,text=True)
    try: d=json.load(open(R+'/out.json'))
    except Exception: return None, p.stdout[-2000:]+p.stderr[-2000:]
    fails=[]
    for f in d['testResults']:
        for a in f['assertionResults']:
            if a['status']=='failed': fails.append(os.path.basename(f['name'])+' > '+a['fullName'])
        if f['status']=='failed' and not f['assertionResults']: fails.append(os.path.basename(f['name'])+' FILE-ERROR')
    return set(fails), None
def restore():
    shutil.rmtree(R+'/src'); shutil.copytree(R+'/src.good',R+'/src')
restore()
base,_=run(); print('BASE',len(base)); 
for k,edits in M.items():
    if only and k not in only: continue
    restore(); ok=True
    for f,o,n in edits:
        s=open(R+'/'+f).read()
        if s.count(o)!=1: print(k,'EDIT MISS',f,repr(o[:60]),s.count(o)); ok=False; break
        open(R+'/'+f,'w').write(s.replace(o,n))
    if not ok: continue
    fails,err=run()
    if fails is None: print(k,'RUN ERROR',err); continue
    new=sorted(fails-base)
    tc=''
    if k=='M27':
        p=subprocess.run(['npx','tsc','--noEmit'],cwd=R,capture_output=True,text=True); tc=' typecheck:'+('FAIL '+p.stdout.strip()[:200] if p.returncode else 'pass')
    print(f"{k}: {'RED' if new else 'GREEN'} ({len(new)}){tc}")
    for t in new[:6]: print('    ',t)
restore()
