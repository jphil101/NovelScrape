from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Optional

import os
from dotenv import load_dotenv

load_dotenv()
from bs4 import BeautifulSoup
from scraper import scrape_url
from nlp import process_chapter_html, character_db

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ScrapeRequest(BaseModel):
    url: str
    db: Optional[dict] = None
    lore_db: Optional[dict] = None
    enable_grammar: bool = False
    llm_config: Optional[dict] = None

from fastapi.responses import StreamingResponse
import json

@app.post("/api/scrape")
def scrape_and_process(req: ScrapeRequest):
    if req.llm_config and req.llm_config.get('use_pro_key'):
        # Fallback priority: NVIDIA -> OPENROUTER -> OPENAI
        if os.getenv("NVIDIA_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("NVIDIA_API_KEY"), "model": "nvidia_nim/openai/gpt-oss-120b", "enabled": True})
        elif os.getenv("OPENROUTER_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENROUTER_API_KEY"), "model": "openrouter/openai/gpt-oss-120b:free", "enabled": True})
        elif os.getenv("OPENAI_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENAI_API_KEY"), "model": "openai/gpt-4o", "enabled": True})
            
    def event_stream():
        yield f"data: {json.dumps({'status': 'Fetching Chapter HTML...', 'progress': 10})}\n\n"
        
        data = scrape_url(req.url)
        if "error" in data:
            yield f"data: {json.dumps({'error': data['error']})}\n\n"
            return
            
        db = req.db if req.db is not None else character_db
        lore_db = req.lore_db if req.lore_db is not None else {}
        
        if data.get("content_html"):
            yield f"data: {json.dumps({'status': 'Sanitizing and Parsing HTML...', 'progress': 30})}\n\n"
            
            for step in process_chapter_html(data["content_html"], db, req.enable_grammar, req.llm_config, lore_db):
                if isinstance(step, dict):
                    yield f"data: {json.dumps(step)}\n\n"
                else:
                    data["content_html"] = step
                    
        yield f"data: {json.dumps({'status': 'Done', 'progress': 100, 'result': data})}\n\n"

    return StreamingResponse(
        event_stream(), 
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.get("/api/ping")
def ping():
    return {"status": "ok"}

@app.post("/api/toc")
def get_toc(req: ScrapeRequest):
    from curl_cffi import requests
    try:
        response = requests.get(req.url, impersonate="chrome110", timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'lxml')
        
        if "novelbin" in req.url:
            rating_div = soup.select_one('#rating')
            novel_id = rating_div['data-novel-id'] if rating_div and rating_div.has_attr('data-novel-id') else req.url.rstrip('/').split('/')[-1]
                
            ajax_url = f"https://novelbin.com/ajax/chapter-archive?novelId={novel_id}"
            ajax_resp = requests.get(ajax_url, impersonate="chrome110", timeout=15)
            ajax_soup = BeautifulSoup(ajax_resp.text, 'lxml')
            
            chapters = []
            for a in ajax_soup.find_all('a'):
                if a.has_attr('href') and 'chapter' in a['href'].lower():
                    chap_title = a.get('title') or a.text.strip()
                    if not chap_title:
                        chap_title = a['href'].rstrip('/').split('/')[-1].replace('-', ' ').title()
                    chapters.append({"title": chap_title, "url": a['href']})
                    
            title = soup.select_one('h3.title').text.strip() if soup.select_one('h3.title') else "Unknown Novel"
            return {"novel_title": title, "chapters": chapters}
        else:
            # Fallback for generic sites
            chapters = []
            for a in soup.find_all('a'):
                if a.has_attr('href') and 'chapter' in a['href'].lower():
                    chapters.append({"title": a.text.strip(), "url": a['href']})
            return {"novel_title": "Novel", "chapters": chapters}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/character-db")
def extract_characters(req: ScrapeRequest):
    if req.llm_config and req.llm_config.get('use_pro_key'):
        if os.getenv("NVIDIA_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("NVIDIA_API_KEY"), "model": "nvidia_nim/openai/gpt-oss-120b", "enabled": True})
        elif os.getenv("OPENROUTER_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENROUTER_API_KEY"), "model": "openrouter/openai/gpt-oss-120b:free", "enabled": True})
        elif os.getenv("OPENAI_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENAI_API_KEY"), "model": "openai/gpt-4o", "enabled": True})

    if not req.llm_config or not req.llm_config.get('api_key'):
        raise HTTPException(status_code=400, detail="LLM API Key is required to extract characters from a Wiki.")
        
    url = req.url
    text = ""
    
    try:
        if "fandom.com/wiki/" in url:
            import urllib.parse, urllib.request, ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            
            base_url = url.split('/wiki/')[0]
            page_title = urllib.parse.unquote(url.split('/wiki/')[1])
            api_url = f"{base_url}/api.php"
            headers = {'User-Agent': 'Mozilla/5.0'}
            
            if page_title.startswith("Category:"):
                query_url = f"{api_url}?action=query&list=categorymembers&cmtitle={urllib.parse.quote(page_title)}&cmlimit=30&format=json"
                req_api = urllib.request.Request(query_url, headers=headers)
                resp = urllib.request.urlopen(req_api, context=ctx)
                import json
                data = json.loads(resp.read())
                
                members = data.get("query", {}).get("categorymembers", [])
                titles = [m["title"] for m in members if not m["title"].startswith("Category:")]
                
                if titles:
                    titles_str = urllib.parse.quote("|".join(titles))
                    content_url = f"{api_url}?action=query&prop=revisions&rvprop=content&titles={titles_str}&format=json"
                    req_content = urllib.request.Request(content_url, headers=headers)
                    resp_content = urllib.request.urlopen(req_content, context=ctx)
                    pages = json.loads(resp_content.read()).get("query", {}).get("pages", {})
                    for page_id, page_data in pages.items():
                        revs = page_data.get("revisions", [])
                        if revs:
                            text += f"\n--- {page_data.get('title')} ---\n"
                            text += revs[0].get("*", "")[:500] 
            else:
                content_url = f"{api_url}?action=query&prop=revisions&rvprop=content&titles={urllib.parse.quote(page_title)}&format=json"
                req_content = urllib.request.Request(content_url, headers=headers)
                resp_content = urllib.request.urlopen(req_content, context=ctx)
                import json
                pages = json.loads(resp_content.read()).get("query", {}).get("pages", {})
                for page_id, page_data in pages.items():
                    revs = page_data.get("revisions", [])
                    if revs:
                        text += revs[0].get("*", "")[:15000]
        else:
            from curl_cffi import requests
            response = requests.get(url, impersonate="chrome110", timeout=15)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'lxml')
            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                tag.decompose()
            text = soup.get_text(separator='\n')[:15000]
            
        import litellm, json
        kwargs = {
            "model": req.llm_config.get('model', 'gpt-3.5-turbo'),
            "messages": [{
                "role": "user", 
                "content": f"Extract a list of characters and their aliases/monikers from the following wiki text. Return ONLY a raw, valid JSON object without any formatting blocks or markdown, where keys are the primary character names, and values are arrays of their aliases/monikers (e.g. {{\"Alice\": [\"Alise\", \"Alica\"], \"John Doe\": [\"Jon Doe\"]}}):\n\n{text}"
            }],
            "api_key": req.llm_config['api_key'],
        }
        if req.llm_config.get('base_url'):
            kwargs["api_base"] = req.llm_config.get('base_url')
            
        resp = litellm.completion(**kwargs)
        result = resp.choices[0].message.content.strip()
        if result.startswith("```json"):
            result = result.split("```json")[1].split("```")[0].strip()
        elif result.startswith("```"):
            result = result.split("```")[1].split("```")[0].strip()
            
        char_db = json.loads(result)
        return {"character_db": char_db}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to extract character DB: {str(e)}")

@app.post("/api/extract-lore")
def extract_lore(req: ScrapeRequest):
    if req.llm_config and req.llm_config.get('use_pro_key'):
        if os.getenv("NVIDIA_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("NVIDIA_API_KEY"), "model": "nvidia_nim/openai/gpt-oss-120b", "enabled": True})
        elif os.getenv("OPENROUTER_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENROUTER_API_KEY"), "model": "openrouter/openai/gpt-oss-120b:free", "enabled": True})
        elif os.getenv("OPENAI_API_KEY"):
            req.llm_config.update({"api_key": os.getenv("OPENAI_API_KEY"), "model": "openai/gpt-4o", "enabled": True})

    if not req.llm_config or not req.llm_config.get('api_key'):
        raise HTTPException(status_code=400, detail="LLM API Key is required to extract lore.")
        
    try:
        from scraper import scrape_url
        data = scrape_url(req.url)
        if "error" in data:
            raise Exception(data["error"])
            
        soup = BeautifulSoup(data["content_html"], 'lxml')
        for tag in soup(["script", "style", "iframe", "object", "embed"]):
            tag.decompose()
        text_content = soup.get_text(separator='\n')[:15000] # Limit to avoid context bloat
        
        import litellm
        import json
        
        kwargs = {
            "model": req.llm_config.get('model', 'openai/gpt-3.5-turbo'),
            "messages": [{"role": "user", "content": f"Extract unique, un-translated foreign terms, martial arts techniques, or specific locations from this novel chapter. Suggest genre-appropriate English translations for them (e.g. 'Jeukcheon' -> 'Crimson Heaven', not 'Red Sky'). Return ONLY a raw JSON dictionary mapping the original term to the suggested translation. Do NOT wrap in markdown blocks.\n\nText: {text_content}"}],
            "api_key": req.llm_config['api_key']
        }
        if req.llm_config.get('base_url'):
            kwargs["api_base"] = req.llm_config['base_url']
            
        response = litellm.completion(**kwargs)
        result = response.choices[0].message.content.strip()
        
        if result.startswith("```json"):
            result = result[7:-3].strip()
        elif result.startswith("```"):
            result = result[3:-3].strip()
            
        lore_dict = json.loads(result)
        return {"lore_db": lore_dict}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
