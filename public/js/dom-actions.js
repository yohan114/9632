'use strict';

// Small click behaviours that used to be inline onclick="..." attributes.
//
// The Content-Security-Policy is enforced with `script-src 'self'` and no 'unsafe-inline', so the
// browser refuses to run any onclick="..." in markup or any javascript: link. Markup says WHAT
// should happen with a data- attribute and this one listener does it. It is loaded by the app shell
// (index.html) and by the server-rendered print pages, so a print button works the same everywhere.
//
//   data-nav="#/stores?tab=x"   go to that screen
//   data-print                  open the print dialog
//   data-back                   browser Back
//   data-close-modal            close the dialog this element sits in (the link still navigates)
//   data-scroll-to="id"         scroll to that element if it is on the page, else follow the link
//   data-click-target="id"      press the button with that id
//   data-nolink                 an <a href="#"> that is really a button: never changes the address
//
// Deliberately no "call this function by name" attribute: that would let any HTML that slipped
// past escaping run any global function, which is the very thing the policy is there to stop.
(function () {
  // Capture phase on window, so it runs before any handler that might stop the click bubbling.
  // Without it a click on <a href="#"> would set the hash to "" and the app would jump to the
  // dashboard.
  window.addEventListener('click', function (e) {
    const t = e.target && e.target.closest ? e.target.closest('a[data-nolink], a[data-back]') : null;
    if (t) e.preventDefault();
  }, true);

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest('[data-nav],[data-print],[data-back],[data-close-modal],[data-scroll-to],[data-click-target]');
    if (!el) return;

    if (el.hasAttribute('data-close-modal')) {
      const bg = el.closest('.modal-bg, .modal-backdrop');
      if (bg) bg.remove();
    }
    if (el.hasAttribute('data-scroll-to')) {
      const target = document.getElementById(el.getAttribute('data-scroll-to'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
        return;
      }
    }
    if (el.hasAttribute('data-nav')) {
      location.hash = el.getAttribute('data-nav');
      return;
    }
    if (el.hasAttribute('data-print')) {
      window.print();
      return;
    }
    if (el.hasAttribute('data-back')) {
      history.back();
      return;
    }
    if (el.hasAttribute('data-click-target')) {
      const btn = document.getElementById(el.getAttribute('data-click-target'));
      if (btn) btn.click();
    }
  });
})();
