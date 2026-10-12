# garganorn prerequisites

Changes garganorn needs before this SDK works end-to-end against a
developer-supplied server (R10) and from browsers (R9). The SDK talks to the
configured server's XRPC endpoints and otherwise follows whatever URLs the
server returns, never constructing its own, so each item here is a server
fix.

## 1. Record URIs must reflect the server's actual base URL

`envelope.record_uri` builds `https://{repo}/{collection}/{rkey}`, with the
scheme hard-coded. Those URIs reach the SDK as the `metadata` links in
`org.atgeo.describeService` and as the `uri` of every record in tiles and
`getRecord` responses. A server reachable any other way, such as a local dev
server on `http://localhost:8000`, hands out links that don't resolve, so
`getCollectionInfo` fails.

Tile URLs don't have this problem: they come from each collection's
configured `base_url`. Record URIs need an equivalent configured public base.

## 2. CORS on XRPC and record routes

Only the tile route (`/tiles/<slug>/...`) sends
`Access-Control-Allow-Origin: *`. The XRPC endpoints (`getCoverage`,
`describeService`, `com.atproto.repo.getRecord`) and the record route
(`/<collection>/<rkey>`) send none, so a browser on another origin can't
call them. Production may add the header at the Caddy layer (not verified),
but a garganorn run without that proxy, such as a developer's own server,
needs it from garganorn itself.
