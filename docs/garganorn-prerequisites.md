# garganorn prerequisites

Changes garganorn needs before this SDK works from browsers (R9) against a
developer-supplied server. The SDK talks to the configured server's XRPC
endpoints and otherwise follows whatever URLs the server returns, never
constructing its own, so each item here is a server fix.

## CORS on XRPC and record routes

Only the tile route (`/tiles/<slug>/...`) sends
`Access-Control-Allow-Origin: *`. The XRPC endpoints (`getCoverage`,
`describeService`, `com.atproto.repo.getRecord`) and the record route
(`/<collection>/<rkey>`) send none, so a browser on another origin can't
call them. Production may add the header at the Caddy layer (not verified),
but a garganorn run without that proxy, such as a developer's own server,
needs it from garganorn itself.
