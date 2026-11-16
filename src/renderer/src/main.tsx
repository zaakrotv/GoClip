import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installFonts } from './api'
import './styles.css'
// Version 0.3 : agenda de publication, file des travaux, éditeur et pattes.
import './styles-v3.css'

installFonts()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
