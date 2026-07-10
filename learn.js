// Belfed Learn — minimal nav behavior (theme toggle + mobile menu).
// Mirrors the homepage's inline handlers so /learn/ pages behave identically.
(function () {
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    });
  }

  var ham = document.getElementById('ham');
  if (ham) {
    ham.addEventListener('click', function () {
      var links = document.querySelector('.nav-links');
      if (!links) return;
      var shown = links.style.display === 'flex';
      links.style.display = shown ? '' : 'flex';
      links.style.position = 'absolute';
      links.style.top = '60px';
      links.style.left = '0';
      links.style.right = '0';
      links.style.background = 'var(--white)';
      links.style.flexDirection = 'column';
      links.style.padding = '20px';
      links.style.borderBottom = '1px solid var(--rule)';
    });
  }
})();
