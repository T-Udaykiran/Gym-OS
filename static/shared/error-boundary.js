// GymOS Global Error Boundary
//
// Vanilla-JS equivalent of a React error boundary: this must be the FIRST
// script tag on every page, before app.js or any other script, so it is
// installed even if app.js itself fails to parse (e.g. a syntax error) -
// that's exactly the scenario that previously left users staring at a
// black screen with no feedback.
//
// window.onerror (not a capturing 'error' listener on window) is used
// deliberately: it fires for uncaught script exceptions and parse errors,
// but NOT for incidental resource failures like a broken avatar image, so a
// missing icon can't trigger a full-screen crash overlay.
(function () {
    var shown = false;

    function showErrorScreen(message) {
        if (shown) return;
        shown = true;

        var overlay = document.createElement('div');
        overlay.id = 'gymos-error-boundary';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647',
            'background:#000', 'color:#fff',
            'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
            'text-align:center', 'padding:32px', 'box-sizing:border-box',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
        ].join(';');

        overlay.innerHTML =
            '<div style="width:56px;height:56px;border-radius:50%;background:rgba(255,69,58,0.15);' +
            'display:flex;align-items:center;justify-content:center;margin-bottom:20px;">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" ' +
            'stroke="#ff453a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line>' +
            '<line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div>' +
            '<h2 style="font-size:19px;font-weight:700;margin:0 0 8px;">Something went wrong</h2>' +
            '<p style="font-size:14px;color:rgba(255,255,255,0.6);margin:0 0 24px;max-width:340px;">' +
            'GymOS hit an unexpected error and couldn\'t continue. Reloading usually fixes this.</p>' +
            '<button id="gymos-error-reload-btn" style="background:#c7ff24;color:#111;border:none;' +
            'border-radius:12px;padding:12px 28px;font-size:14px;font-weight:700;cursor:pointer;">' +
            'Reload App</button>';

        (document.body || document.documentElement).appendChild(overlay);
        var btn = document.getElementById('gymos-error-reload-btn');
        if (btn) btn.addEventListener('click', function () { window.location.reload(); });

        try {
            console.error('[GymOS Error Boundary]', message);
        } catch (e) { /* console unavailable */ }
    }

    window.onerror = function (message, source, lineno, colno, error) {
        showErrorScreen(message + ' (' + source + ':' + lineno + ':' + colno + ')');
        // Returning false keeps default browser logging so DevTools still
        // shows the real stack trace during development.
        return false;
    };

    window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason;
        var message = (reason && (reason.stack || reason.message)) || String(reason);
        showErrorScreen('Unhandled promise rejection: ' + message);
    });
})();
