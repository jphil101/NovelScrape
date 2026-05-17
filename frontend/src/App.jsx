import { useState, useEffect, useRef } from 'react';
import './App.css';

function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? JSON.parse(item) : initialValue;
    } catch (error) {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(error);
    }
  }, [key, value]);

  return [value, setValue];
}

const openDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('NexusReaderDB', 1);
        request.onupgradeneeded = (e) => {
            e.target.result.createObjectStore('chapters', { keyPath: 'url' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

const saveChapter = async (url, data) => {
    const db = await openDB();
    const tx = db.transaction('chapters', 'readwrite');
    tx.objectStore('chapters').put({ url, data });
};

const getChapter = async (url) => {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('chapters', 'readonly');
        const req = tx.objectStore('chapters').get(url);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
    });
};

function App() {
  const [url, setUrl] = useLocalStorage('nexus_url', 'https://novelbin.com/b/childhood-friend-of-the-zenith#tab-chapters-title');
  const [chapterData, setChapterData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(true);
  
  // Sidebar & Bulk Scrape State
  const [toc, setToc] = useLocalStorage('nexus_toc', null);
  const [showToc, setShowToc] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [scrapeProgress, setScrapeProgress] = useState({ current: 0, total: 0, active: false });
  const [charDb, setCharDb] = useLocalStorage('nexus_charDB', {});
  
  const prefetchingRef = useRef(null);

  // Settings State
  const [theme, setTheme] = useLocalStorage('nexus_theme', 'light');
  const [fontSize, setFontSize] = useLocalStorage('nexus_fontSize', 18);
  const [fontFamily, setFontFamily] = useLocalStorage('nexus_fontFamily', 'sans'); // sans, serif, display
  const [enableGrammar, setEnableGrammar] = useLocalStorage('nexus_enableGrammar', false);
  
  // LLM Config State
  const [llmEnabled, setLlmEnabled] = useLocalStorage('nexus_llmEnabled', false);
  const [llmProvider, setLlmProvider] = useLocalStorage('nexus_llmProvider', 'openai');
  const [llmApiKey, setLlmApiKey] = useLocalStorage('nexus_llmApiKey', '');
  const [llmModel, setLlmModel] = useLocalStorage('nexus_llmModel', 'gpt-3.5-turbo');
  const [llmChunkSize, setLlmChunkSize] = useLocalStorage('nexus_llmChunkSize', 5);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Background Prefetching
  useEffect(() => {
    if (!loading && chapterData?.next_url && !scrapeProgress.active) {
      if (prefetchingRef.current !== chapterData.next_url) {
        prefetchChapter(chapterData.next_url);
      }
    }
  }, [chapterData, loading, scrapeProgress.active]);

  const prefetchChapter = async (targetUrl) => {
    let data = await getChapter(targetUrl);
    if (data) return; // Already cached
    
    prefetchingRef.current = targetUrl;
    try {
        const response = await fetch('http://localhost:8000/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: targetUrl,
            db: Object.keys(charDb).length > 0 ? charDb : null,
            enable_grammar: enableGrammar,
            llm_config: { enabled: llmEnabled, api_key: llmApiKey, model: llmProvider === 'openai' ? llmModel : `${llmProvider}/${llmModel}`, sentences_per_chunk: parseInt(llmChunkSize) || 5 }
          })
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finalData = null;
        let isDone = false;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); 
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const msg = JSON.parse(line.substring(6));
                    if (msg.status === 'Done') {
                        finalData = msg.result;
                        isDone = true;
                    }
                }
            }
            if (isDone) {
                reader.cancel();
                break;
            }
        }
        if (finalData) await saveChapter(targetUrl, finalData);
    } catch(e) { console.error("Prefetch error:", e); }
  };

  const fetchChapter = async (targetUrl) => {
    if (!targetUrl) return;
    setLoading(true);
    setStatusMessage('Fetching from local database...');
    setError(null);
    try {
      let data = await getChapter(targetUrl);
      if (!data) {
          const response = await fetch('http://localhost:8000/api/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              url: targetUrl,
              db: Object.keys(charDb).length > 0 ? charDb : null,
              enable_grammar: enableGrammar,
              llm_config: {
                enabled: llmEnabled,
                api_key: llmApiKey,
                model: llmProvider === 'openai' ? llmModel : `${llmProvider}/${llmModel}`,
                sentences_per_chunk: parseInt(llmChunkSize) || 5
              }
            })
          });
          
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          
          while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              
              const lines = buffer.split('\n\n');
              buffer = lines.pop(); 
              
              let isDone = false;
              for (const line of lines) {
                  if (line.startsWith('data: ')) {
                      const msg = JSON.parse(line.substring(6));
                      if (msg.error) throw new Error(msg.error);
                      if (msg.status === 'Done') {
                          data = msg.result;
                          isDone = true;
                      } else {
                          setStatusMessage(msg.status);
                      }
                  }
              }
              if (isDone) {
                  reader.cancel();
                  break;
              }
          }
          
          if (!data) throw new Error('Stream ended prematurely');
          await saveChapter(targetUrl, data);
      }
      
      setChapterData(data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setStatusMessage('');
    }
  };
  
  const fetchToc = async (targetUrl) => {
    if (!targetUrl) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('http://localhost:8000/api/toc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Failed to load TOC');
      setToc(data);
      setShowToc(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startBulkScrape = async () => {
    if (!toc || !toc.chapters) return;
    setScrapeProgress({ current: 0, total: toc.chapters.length, active: true, message: 'Starting bulk scrape...' });
    
    for (let i = 0; i < toc.chapters.length; i++) {
        if (i > 0 && document.getElementById('abort-flag')?.value === 'true') {
             break; // allow abort logic
        }
        const chapUrl = toc.chapters[i].url;
        let existing = await getChapter(chapUrl);
        if (!existing) {
           try {
             const response = await fetch('http://localhost:8000/api/scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: chapUrl, db: Object.keys(charDb).length > 0 ? charDb : null, enable_grammar: enableGrammar, llm_config: { enabled: llmEnabled, api_key: llmApiKey, model: llmProvider === 'openai' ? llmModel : `${llmProvider}/${llmModel}`, sentences_per_chunk: parseInt(llmChunkSize) || 5 } })
             });
             
             const reader = response.body.getReader();
             const decoder = new TextDecoder('utf-8');
             let buffer = '';
             let data = null;
             
             let isDone = false;
             while (true) {
                 const { done, value } = await reader.read();
                 if (done) break;
                 buffer += decoder.decode(value, { stream: true });
                 const lines = buffer.split('\n\n');
                 buffer = lines.pop(); 
                 
                 for (const line of lines) {
                     if (line.startsWith('data: ')) {
                         const msg = JSON.parse(line.substring(6));
                         if (msg.status === 'Done') {
                             data = msg.result;
                             isDone = true;
                         } else if (!msg.error) {
                             setScrapeProgress(prev => ({ ...prev, message: `Chapter ${i+1}: ${msg.status}` }));
                         }
                     }
                 }
                 if (isDone) {
                     reader.cancel();
                     break;
                 }
             }
             if (data) await saveChapter(chapUrl, data);
             // Let GC run to prevent browser freeze
             await new Promise(r => setTimeout(r, 200));
           } catch(e) {}
        }
        setScrapeProgress(prev => ({ ...prev, current: i + 1 }));
    }
    setScrapeProgress(prev => ({ ...prev, active: false, message: '' }));
  };

  const handleNext = () => {
    if (chapterData?.next_url) fetchChapter(chapterData.next_url);
  };

  const handlePrev = () => {
    if (chapterData?.prev_url) fetchChapter(chapterData.prev_url);
  };

  const getFontClass = () => {
    if (fontFamily === 'serif') return 'font-serif';
    if (fontFamily === 'display') return 'font-display';
    return 'font-sans';
  };

  return (
    <div className={`app-container ${getFontClass()}`} style={{ '--font-size': `${fontSize}px` }}>
      <nav className="navbar glass-panel" style={{ borderRadius: 0, borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}>
        <button className="controls-toggle" onClick={() => setShowToc(true)}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div className="nav-brand">NexusReader</div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="controls-toggle" onClick={() => setShowSearch(!showSearch)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </button>
          <button className="controls-toggle" onClick={() => setShowSettings(!showSettings)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
        </div>
      </nav>

      {/* TOC Sidebar */}
      <div className={`toc-sidebar glass-panel ${showToc ? 'open' : ''}`} style={{ borderRadius: 0 }}>
        <div className="toc-header">
          <h2 style={{ fontSize: '1.2rem', fontFamily: 'Outfit, sans-serif' }}>{toc ? toc.novel_title : 'Table of Contents'}</h2>
          <button className="toc-close" onClick={() => setShowToc(false)}>&times;</button>
        </div>
        
        {scrapeProgress.active && (
          <div style={{ marginBottom: '1rem' }}>
            <div className="progress-container">
              <div className="progress-bar" style={{ width: `${(scrapeProgress.current / scrapeProgress.total) * 100}%` }}></div>
            </div>
            <div className="progress-text">Scraped: {scrapeProgress.current} / {scrapeProgress.total} chapters</div>
            {scrapeProgress.message && (
              <div style={{ fontSize: '0.75rem', marginTop: '0.5rem', opacity: 0.7, textAlign: 'center', wordBreak: 'break-word' }}>
                {scrapeProgress.message}
              </div>
            )}
            <input type="hidden" id="abort-flag" value="false" />
            <button className="btn" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', marginTop: '0.5rem', width: '100%', justifyContent: 'center' }} onClick={() => document.getElementById('abort-flag').value = 'true'}>Pause Scraping</button>
          </div>
        )}

        <input 
          type="text" 
          placeholder="Search chapter..." 
          className="toc-search" 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        
        <ul className="toc-list">
          {!toc && <p style={{opacity: 0.7, fontSize: '0.9rem'}}>Fetch TOC to load chapters.</p>}
          {toc?.chapters?.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase())).map((chap, i) => (
            <li key={i}>
              <button 
                className={`toc-item ${chap.url === chapterData?.url ? 'active' : ''}`}
                onClick={() => { setShowToc(false); fetchChapter(chap.url); }}
              >
                {chap.title}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {showSettings && (
        <div className="settings-modal glass-panel animate-fade-in">
          <div className="settings-group">
            <h3>Theme</h3>
            <div className="button-group">
              <button className={`setting-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>Light</button>
              <button className={`setting-btn ${theme === 'sepia' ? 'active' : ''}`} onClick={() => setTheme('sepia')}>Sepia</button>
              <button className={`setting-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>Dark</button>
            </div>
          </div>
          
          <div className="settings-group">
            <h3>Font Family</h3>
            <div className="button-group">
              <button className={`setting-btn font-sans ${fontFamily === 'sans' ? 'active' : ''}`} onClick={() => setFontFamily('sans')}>Sans</button>
              <button className={`setting-btn font-serif ${fontFamily === 'serif' ? 'active' : ''}`} onClick={() => setFontFamily('serif')}>Serif</button>
              <button className={`setting-btn font-display ${fontFamily === 'display' ? 'active' : ''}`} onClick={() => setFontFamily('display')}>Display</button>
            </div>
          </div>

          <div className="settings-group">
            <h3>Font Size ({fontSize}px)</h3>
            <div className="button-group">
              <button className="setting-btn" onClick={() => setFontSize(f => Math.max(12, f - 2))}>A-</button>
              <button className="setting-btn" onClick={() => setFontSize(f => Math.min(32, f + 2))}>A+</button>
            </div>
          </div>

          <div className="settings-group">
            <h3>NLP Features</h3>
            <div className="button-group">
              <button className={`setting-btn ${enableGrammar ? 'active' : ''}`} onClick={() => setEnableGrammar(!enableGrammar)}>
                Auto Grammar Fix
              </button>
            </div>
            <p style={{ fontSize: '0.75rem', marginTop: '0.5rem', opacity: 0.7 }}>Character correction is always active.</p>
          </div>

          <div className="settings-group">
            <h3>LLM Failsafe</h3>
            <div className="button-group" style={{ marginBottom: '0.5rem' }}>
              <button className={`setting-btn ${llmEnabled ? 'active' : ''}`} onClick={() => setLlmEnabled(!llmEnabled)}>
                {llmEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            {llmEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                <select 
                  className="url-input" 
                  value={llmProvider} 
                  onChange={(e) => setLlmProvider(e.target.value)}
                  style={{ padding: '0.5rem', fontSize: '0.875rem', borderRadius: '8px' }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama</option>
                  <option value="nvidia_nim">NVIDIA NIM</option>
                </select>
                <input 
                  type="text" 
                  placeholder="Model (e.g. gpt-4o, claude-3)" 
                  className="url-input" 
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  style={{ padding: '0.5rem', fontSize: '0.875rem', borderRadius: '8px' }}
                />
                <input 
                  type="password" 
                  placeholder="API Key" 
                  className="url-input" 
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  style={{ padding: '0.5rem', fontSize: '0.875rem', borderRadius: '8px' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <label style={{ fontSize: '0.875rem' }}>Sentences per LLM Chunk (Batch size):</label>
                  <input 
                    type="number" 
                    className="url-input" 
                    value={llmChunkSize}
                    onChange={(e) => setLlmChunkSize(e.target.value)}
                    style={{ padding: '0.5rem', fontSize: '0.875rem', borderRadius: '8px', width: '80px' }}
                    min="1"
                    max="50"
                  />
                </div>
              </div>
            )}
          </div>
          
          <div className="settings-group">
            <h3>Character Database (Wiki Scrape)</h3>
            <p style={{ fontSize: '0.75rem', marginBottom: '0.5rem', opacity: 0.7 }}>Fetch names/aliases from Fandom/Wiki URL. Requires LLM to be enabled.</p>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input 
                type="text" 
                id="wiki-url"
                placeholder="https://novel-name.fandom.com/wiki/Characters" 
                className="url-input" 
                style={{ padding: '0.5rem', fontSize: '0.875rem', borderRadius: '8px' }}
              />
              <button 
                className="btn" 
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
                onClick={async () => {
                  const url = document.getElementById('wiki-url').value;
                  if (!url) return;
                  if (!llmEnabled || !llmApiKey) {
                    alert('LLM API Key is required to extract character aliases.');
                    return;
                  }
                  document.getElementById('wiki-btn').innerText = 'Scraping...';
                  try {
                    const res = await fetch('http://localhost:8000/api/character-db', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ url, llm_config: { api_key: llmApiKey, model: llmProvider === 'openai' ? llmModel : `${llmProvider}/${llmModel}` } })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.detail);
                    setCharDb(data.character_db);
                    alert(`Successfully extracted ${Object.keys(data.character_db).length} characters!`);
                  } catch(e) {
                    alert(`Error: ${e.message}`);
                  } finally {
                    document.getElementById('wiki-btn').innerText = 'Extract';
                  }
                }}
                id="wiki-btn"
              >Extract</button>
            </div>
            <div style={{ fontSize: '0.75rem', opacity: 0.8, maxHeight: '80px', overflowY: 'auto', background: 'var(--bg-color)', padding: '0.5rem', borderRadius: '4px' }}>
              {Object.keys(charDb).length > 0 ? (
                <pre style={{ margin: 0 }}>{JSON.stringify(charDb, null, 2)}</pre>
              ) : "No characters loaded."}
            </div>
            {Object.keys(charDb).length > 0 && (
              <button className="btn" style={{ background: '#ef4444', marginTop: '0.5rem', fontSize: '0.75rem', padding: '0.3rem' }} onClick={() => setCharDb({})}>Clear DB</button>
            )}
          </div>
        </div>
      )}

      {showSearch && (
        <div className="input-group animate-fade-in" style={{ paddingBottom: '1rem', borderBottom: '1px solid var(--panel-border)', background: 'var(--panel-bg)' }}>
          <input 
            type="text" 
            className="url-input" 
            value={url} 
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste novel URL here..."
            onKeyDown={(e) => e.key === 'Enter' && fetchChapter(url)}
          />
          <button className="btn" onClick={() => fetchChapter(url)}>Load Chapter</button>
          <button className="btn" style={{background: 'var(--text-color)', color: 'var(--bg-color)'}} onClick={() => fetchToc(url)}>Fetch TOC</button>
          {toc && !scrapeProgress.active && (
            <button className="btn" style={{background: '#10b981'}} onClick={startBulkScrape}>Bulk Scrape</button>
          )}
        </div>
      )}

      <main className="reader-container">
        {loading && (
          <div className="loader" style={{ flexDirection: 'column', gap: '1rem' }}>
            <div className="spinner"></div>
            {statusMessage && <div style={{ fontSize: '1rem', fontWeight: '500', color: 'var(--text-color)' }}>{statusMessage}</div>}
          </div>
        )}
        
        {error && (
          <div style={{ color: '#ef4444', textAlign: 'center', padding: '2rem' }}>
            <h2>Error Loading Chapter</h2>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && chapterData && (
          <div className="animate-fade-in">
            <h1 className="chapter-title">{chapterData.title}</h1>
            <div 
              className="chapter-content"
              dangerouslySetInnerHTML={{ __html: chapterData.content_html }} 
            />
          </div>
        )}
      </main>

      {!loading && !error && chapterData && (
        <div className="bottom-nav glass-panel" style={{ borderRadius: '16px 16px 0 0', borderBottom: 'none', borderLeft: 'none', borderRight: 'none' }}>
          <button className="btn" disabled={!chapterData.prev_url} onClick={handlePrev}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            Prev
          </button>
          <button className="btn" disabled={!chapterData.next_url} onClick={handleNext}>
            Next
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
