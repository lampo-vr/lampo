// The offline screen: try again on request, and on its own once the network is back.
document.getElementById('retry')?.addEventListener('click', () => location.reload());
addEventListener('online', () => location.reload());
