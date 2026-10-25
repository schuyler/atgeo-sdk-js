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
'M28-uri-fixed':[(C,FILTER,"prefix === undefined || inCollection({ ...record.value, origin: recordKey(record) ?? undefined }, prefix)"),(C,'import { dedupe, inRegion, locate } from "./merge.js";','import { dedupe, inRegion, locate, recordKey } from "./merge.js";')],
'M3-acrossOnly':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution([...used].reverse().map((u) => (loaded.get(u)!.attribution ?? []).filter((e, i, l) => l.findIndex((f) => f.dataset === e.dataset && f.collection === e.collection) === i)));")],
'M3-withinOnly':[(C,"const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));","const attribution = mergeAttribution(used.map((u) => [...(loaded.get(u)!.attribution ?? [])].reverse()));")],
'M4a':[(A,MERGE_LOOP,"""    const k = e.dataset + ':' + e.collection; if ((seen as any).has(k)) continue;
    (seen as any).set(k, e);
    out.push(e);""")],
'M4b':[(A,MERGE_LOOP,"""    const k = e.dataset + '|' + e.collection; if ((seen as any).has(k)) continue;
    (seen as any).set(k, e);
    out.push(e);""")],
'N19-similarityNotTypeError':[(C,"""if (sort === "similarity" && !query) throw new TypeError(""","""if (sort === "similarity" && !query) throw new Error(""")],
'N22-mergeFillMissingFields':[(A,"    if (inner.has(e.collection)) continue;","    if (inner.has(e.collection)) { const k = inner.get(e.collection)! as any; for (const f of Object.keys(e)) if (k[f] === undefined) k[f] = (e as any)[f]; continue; }")],
'N23-caseFoldPair':[(A,MERGE_LOOP,"""    const k = JSON.stringify([e.dataset.toLowerCase(), e.collection.toLowerCase()]); if ((seen as any).has(k)) continue;
    (seen as any).set(k, e);
    out.push(e);""")],
'N25-dedupeWholeEntry':[(A,MERGE_LOOP,"""    const k = JSON.stringify(e); if ((seen as any).has(k)) continue;
    (seen as any).set(k, e);
    out.push(e);""")],
'N26-datasetCheckAfterSort':[(C,"""    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");
    validateRegion(options.region);
    const sort = options.sort ?? "fused";
    const query = normalize(options.text ?? "");
    if (sort === "similarity" && !query) throw new TypeError("sort 'similarity' requires text");""","""    validateRegion(options.region);
    const sort = options.sort ?? "fused";
    const query = normalize(options.text ?? "");
    if (sort === "similarity" && !query) throw new TypeError("sort 'similarity' requires text");
    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");""")],
'N27-datasetAsyncReject':[(C,"""    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");
    validateRegion""","""    if (typeof (options as { dataset?: unknown }).dataset !== "string") return Promise.reject(new TypeError("searchPlaces requires a dataset"));
    validateRegion""")],
'N28-tileAttrEntryPresentNotApplied':[(W,"""    out.push(present({
      dataset: o.dataset,""","""    out.push(({
      dataset: o.dataset,""")],
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
