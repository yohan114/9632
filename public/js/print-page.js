// The "Print / Save as PDF" button on printable pages, without an inline handler.
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('print');
  if (b) b.addEventListener('click', () => window.print());
});
