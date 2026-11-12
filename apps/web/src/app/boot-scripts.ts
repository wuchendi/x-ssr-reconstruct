// Inline scripts rendered into <head>. Kept as plain strings: they run before
// any bundle exists.

// Replay registry: data <script>s streamed into <body> call __rr.p().
export const REPLAY_REGISTRY = `self.__rr={m:new Map,w:new Map,done:!1,p:function(){var s=document.currentScript,j=s.previousElementSibling,k=j.getAttribute("data-rr");this.m.set(k,j.textContent);j.remove();s.remove();var w=this.w.get(k);if(w){this.w.delete(k);w.forEach(function(f){f()})}}};`

// "The stylesheet first": JS doesn't start downloading until the
// render-blocking stylesheet has loaded, so it doesn't steal bandwidth from
// first paint. Then the entry is added as an *async* module (runs as soon as it
// loads, not after the whole streamed document is parsed) plus modulepreloads
// for the chunks the server rendered.
export function stylesheetFirstLoader(entry: string, preloads: string[]): string {
  const payload = JSON.stringify({ e: entry, p: preloads }).replace(/</g, '\\u003c')
  return `(function(a){function go(){var h=document.head;a.p.forEach(function(u){var l=document.createElement("link");l.rel="modulepreload";l.href=u;h.appendChild(l)});var s=document.createElement("script");s.type="module";s.async=!0;s.src=a.e;h.appendChild(s)}var c=document.getElementById("app-css");if(!c||c.sheet)go();else{c.addEventListener("load",go);c.addEventListener("error",go)}})(${payload})`
}
