if ('serviceWorker' in navigator) {
  // Register before window.load so slow page resources cannot block offline preparation.
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
    console.error('Service worker registration failed.', error);
  });
}
