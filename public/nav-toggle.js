document.addEventListener('DOMContentLoaded', function() {
  var toggle = document.querySelector('.nav-toggle');
  if (!toggle) return;
  var header = toggle.closest('header') || toggle.parentElement;
  var nav = header.querySelector('.site-nav') || header.querySelector('.header-nav');
  if (!nav) return;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', function() {
    var open = nav.classList.toggle('nav-open');
    toggle.textContent = open ? '\u00D7' : '\u2261';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});
