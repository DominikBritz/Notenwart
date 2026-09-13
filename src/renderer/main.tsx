import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { maybeAutorun } from './autorun';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
maybeAutorun().then((handled) => {
  if (handled === true) {
    root.render(<main style={{ padding: 24 }}>Autorun abgeschlossen.</main>);
    return;
  }
  if (handled && handled !== 'einstellungen') {
    root.render(<App initial={handled} />);
    return;
  }
  root.render(
    <React.StrictMode>
      <App openSettings={handled === 'einstellungen'} />
    </React.StrictMode>,
  );
});
