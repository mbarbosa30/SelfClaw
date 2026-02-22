(function() {
  var params = new URLSearchParams(window.location.search);
  if (params.get('theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    return;
  } else if (params.get('theme') === 'light') {
    return;
  }
  var saved = localStorage.getItem('selfclaw-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (!saved) {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }
})();

function initThemeToggle() {
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function updateIcon() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? '\u263C' : '\u263E';
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  updateIcon();

  btn.addEventListener('click', function() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('selfclaw-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('selfclaw-theme', 'dark');
    }
    updateIcon();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initThemeToggle);
} else {
  initThemeToggle();
}
