import http from 'node:http';

export const BAD_PAGE = `<html><head><title>Home</title></head><body bgcolor="#ccc">
<center><font face="Arial" size="2">Welcome to Joe's Plumbing</font></center>
<table><tr><td><table><tr><td><table><tr><td>Menu</td></tr></table></td></tr></table></td></tr></table>
<table width="1200"><tr><td>Call us</td></tr></table>
<script src="/js/jquery-1.7.2.min.js"></script>
<p style="font-size:9px">Serving Denver since 1998</p>
<img src="/a.png"><img src="/b.png"><img src="/c.png"><img src="/d.png"><img src="/e.png">
<div id="footer">&copy; 2012 Joe's Plumbing. All rights reserved. Email: joe@joesplumbing.test</div>
</body></html>`;

export const GOOD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Cherry Creek Dental | Family Dentist in Denver</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Gentle family dentistry in Cherry Creek.">
<meta property="og:title" content="Cherry Creek Dental"><meta property="og:image" content="/og.jpg">
<style>body{font:16px system-ui;margin:0;padding:16px}img{max-width:100%}</style></head>
<body><h1>Cherry Creek Dental</h1>
<p>${'We provide gentle, modern dental care for the whole family. '.repeat(8)}</p>
<a href="tel:+13035550100" style="display:inline-block;padding:14px 20px">Call (303) 555-0100</a>
<a href="/book" style="display:inline-block;padding:14px 20px">Book now</a>
<footer>&copy; ${new Date().getFullYear()} Cherry Creek Dental</footer></body></html>`;

// Fixed-width 1200px layout with no viewport tag: the classic broken-on-mobile site.
export const DESKTOP_ONLY_PAGE = `<html><head><title>Mile High Auto Repair</title></head>
<body style="margin:0"><div style="width:1200px;background:#eee;padding:20px"><h1>Mile High Auto</h1>
<p style="font-size:10px">${'Brakes, oil changes, and more. '.repeat(30)}</p></div>
<footer>&copy; 2011 Mile High Auto</footer></body></html>`;

// Same fixed 1200px layout, but WITH a viewport tag: the page doesn't zoom out, it scrolls sideways.
export const FIXED_WITH_VIEWPORT_PAGE = DESKTOP_ONLY_PAGE.replace(
  '<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">',
);

/** Local server: /bad, /good, /desktop, /fixed, /parked, /missing. */
export function startServer() {
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    switch (req.url) {
      case '/bad': return send(200, BAD_PAGE);
      case '/good': return send(200, GOOD_PAGE);
      case '/desktop': return send(200, DESKTOP_ONLY_PAGE);
      case '/fixed': return send(200, FIXED_WITH_VIEWPORT_PAGE);
      case '/parked': return send(200, '<html><body><h1>This domain is for sale</h1></body></html>');
      case '/missing': return send(404, 'nope');
      default: return send(404, 'not found');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
