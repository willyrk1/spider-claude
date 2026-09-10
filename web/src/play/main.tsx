import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Play from './Play';
import './play.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Play />
  </StrictMode>,
);
