# Tranche C: atgeo-sdk-js #43 port-contract revision — APPROVED REQUIREMENTS
Umbrella: https://github.com/schuyler/atgeo-sdk-js/issues/43. Linked decision comments are binding:
atgeo-sdk-js #30, #32; garganorn #14, #15, #16, #19.
garganorn's lexicon changes (tranche B) are being done in parallel; the names below are final.

10. (S) docs/port-contract.md revision implemented in the TypeScript reference (src/):
  - #32: `dataset` required on search, no default. Remove the two §4.1 rows for an absent
    dataset; dataset w/o collection = whole dataset. Missing dataset = argument error before any
    request (TS idiom: required param in type AND runtime throw for JS callers). READMEs pass
    dataset explicitly; "Server requirements" sections drop the overturemaps.org/place assumption.
  - #30: `SearchResult.attribution`: union of every loaded tile's `attribution` entries, deduped
    by (dataset, collection), INCLUDING reference entries (not just collections that produced
    hits), sorted by (dataset, collection) in ordinal string order. `SearchHit.collection:
    {dataset, collection} | null`, filled by matching the hit's origin against
    `urn:atgeo:{dataset}:{collection}:` for each entry in the tile's attribution (prefix match,
    no URN parsing; reuse the §4.7 collection-filter test); no match → null. Tile cache keeps
    each tile's attribution with its records (§4.4, §10) so a warm search still has it.
    `describeTileset` stays uncached.
  - garganorn#15: getPlace transport reads new response `{ uri, url, importance?, value,
    attribution }`; `PlaceRecord` exposes `attribution`. Public API keeps `origin` and `place`.
    Contract adds one sentence: SDK `origin` ↔ wire record key (`uri` param/response); SDK
    `place` ↔ wire `value`.
  - garganorn#14: §4.1 and §8 note that dataset-only ranking across tilesets is sound under the
    revised spec wording (importance comparable across one producer's tilesets for one dataset).
    No behaviour change.
  - garganorn#16: port specs (docs/*-sdk-spec.md) and READMEs name bbox region fields `west`,
    `south`, `east`, `north`. Wire array order unchanged.
  - garganorn#19: §9 describeService and describeTileset pass through new `maxTiles` and
    `overview: { records }` leniently (absent/unknown tolerated).
  - Fixtures (fixtures/) updated for attribution, new getPlace shape, and lenient-reader cases
    for new describe fields.
  - Update the contract's pinned reference commit (the TS reference commit the contract cites);
    after merge, the port tickets get the merge commit.
  Accept: TS unit suite + updated fixtures pass; lint/typecheck pass.
  (I) atgeo-sdk-js #31 and #33 out of scope unless they fall out naturally.
Process: TDD red→green (vitest).

## Sequencing fact
test/lexicon/ vendors garganorn/lexicon/ at a pinned garganorn commit (test/lexicon/SOURCE; port-contract
§ on SOURCE pins; CI byte-checks). The new lexicons come from garganorn tranche B, which merges first;
C re-vendors at the garganorn commit where B's lexicon changes land on main. Design accordingly:
until then, work against B's branch lexicons, and re-vendor before C's PR.
