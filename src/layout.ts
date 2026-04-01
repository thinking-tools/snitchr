import { APP_VERSION, BUILD_COMMIT, BUILD_TIME } from './version';

const NAV = `<nav class="top-nav">
      <a href="/" class="top-nav-brand">
        <img src="/static/icon-transparent-white.svg" alt="" width="24" height="24" />
        <span>snitchr</span>
      </a>
      <div class="top-nav-links">
        <a href="/">Dashboard</a>
        <a href="/settings">Settings</a>
        <a href="/api/logout" class="top-nav-logout">Logout</a>
      </div>
    </nav>`;

const NAV_SCRIPT = `document.querySelectorAll('.top-nav-links a[href]').forEach(a=>{const p=location.pathname;if(a.getAttribute('href')===p||(a.getAttribute('href')==='/'&&(p==='/'||p.startsWith('/machine/'))))a.setAttribute('aria-current','page')})`;

const FOOTER = `<footer class="app-footer">
      <div class="app-footer-links">
       <a href="https://snitchr.sh" rel="noopener">Web</a>
    <a href="https://github.com/thinking-tools/snitchr/wiki" target="_blank" rel="noopener">Docs</a>
    <a href="https://github.com/thinking-tools/snitchr" target="_blank" rel="noopener">GitHub</a>
    <a href="https://github.com/sponsors/good-lly" target="_blank" rel="noopener" class="sponsor-link">❤️ Sponsor</a>
    <a href="https://www.npmjs.com/package/snitchr" target="_blank" rel="noopener">npm</a>
    <a href="https://github.com/thinking-tools/snitchr/issues" target="_blank" rel="noopener">Feedback</a>
    
  </div>
        <small>
    <a href="https://github.com/thinking-tools/snitchr/releases/tag/v${APP_VERSION}" target="_blank" rel="noopener">v${APP_VERSION}</a>
    ·
    <a href="https://github.com/thinking-tools/snitchr/commit/${BUILD_COMMIT}" target="_blank" rel="noopener" title="Verify build provenance">${BUILD_COMMIT.slice(0, 7)}</a>
    · ${BUILD_TIME.slice(0, 16).replace('T', ' ')} UTC
  </small>
  <small>Open source · <a href="https://github.com/thinking-tools/snitchr/blob/dev/LICENSE" target="_blank" rel="noopener">MIT</a> · Use at your own risk</small>
    </footer>`;

const NO_NAV = new Set(['Setup', 'Login']);

/** Wrap a page fragment (styles + body + scripts) in the shared HTML shell. */
export const layout = (title: string, body: string): string => {
  const showNav = !NO_NAV.has(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} | snitchr</title>
    <link rel="icon" type="image/png" href="/static/favicon-96x96.png?v=20260401" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg?v=20260401" />
    <link rel="shortcut icon" href="/static/favicon.ico?v=20260401" />
    <link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png?v=20260401" />
    <meta name="apple-mobile-web-app-title" content="snitchr" />
    <link rel="manifest" href="/static/site.webmanifest?v=20260401" />
    <link rel="stylesheet" href="/static/vendor/oat-glassed.min.css" />
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    ${showNav ? NAV : ''}
    ${body}
    ${showNav ? FOOTER : ''}
    <script src="/static/vendor/oat-glassed.min.js"></script>
    <script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});${showNav ? NAV_SCRIPT : ''}
;(function(){var t=document.createElement('div');t.className='tip-popup';document.body.appendChild(t);document.addEventListener('pointerenter',function(e){var el=e.target&&e.target.closest&&e.target.closest('[data-tip]');if(!el)return;t.textContent=el.dataset.tip;var r=el.getBoundingClientRect();t.style.left=r.left+r.width/2+'px';t.style.top=r.top-6+'px';t.classList.add('visible')},true);document.addEventListener('pointerleave',function(e){if(e.target&&e.target.closest&&e.target.closest('[data-tip]'))t.classList.remove('visible')},true)})();</script>
  </body>
</html>`;
};
