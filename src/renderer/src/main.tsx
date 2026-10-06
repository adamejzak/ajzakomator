import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// Handle for automated smoke tests driven over the DevTools protocol.
import * as actions from './actions';
import { useStore } from './store';
import { terminals } from './terminals/TerminalManager';
(window as unknown as { __mc: unknown }).__mc = { actions, useStore, terminals };
