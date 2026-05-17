from bs4 import BeautifulSoup
import cloudscraper
import re
from typing import Optional, Dict
from urllib.parse import urljoin

class SiteParser:
    def parse(self, html: str, url: str) -> Dict[str, str]:
        raise NotImplementedError

class NovelBinParser(SiteParser):
    def parse(self, html: str, url: str) -> Dict[str, str]:
        soup = BeautifulSoup(html, 'lxml')
        title_tag = soup.select_one('.chr-title, .chapter-title, span.chr-text')
        title = title_tag.text.strip() if title_tag else "Unknown Chapter"
        
        content_tag = soup.select_one('#chr-content, .chapter-content')
        if not content_tag:
            content_tag = soup.select_one('.chr-c')
        
        content_html = ""
        if content_tag:
            # Remove scripts, ads
            for tag in content_tag.select('script, ins, .ads'):
                tag.decompose()
            content_html = str(content_tag)
        else:
            # Check if this is the novel index page
            first_chap = soup.select_one('#list-chapter a, .list-chapter a, ul.list-chapter a')
            if first_chap and first_chap.has_attr('href'):
                return {"redirect": first_chap['href']}
            content_html = "<p>Content not found.</p>"
            
        next_btn = soup.select_one('#next_chap, a[data-chapter-nav="next"]')
        next_url = next_btn['href'] if next_btn and next_btn.has_attr('href') and next_btn['href'] != 'javascript:void(0)' else None
        
        prev_btn = soup.select_one('#prev_chap, a[data-chapter-nav="prev"]')
        prev_url = prev_btn['href'] if prev_btn and prev_btn.has_attr('href') and prev_btn['href'] != 'javascript:void(0)' else None
        
        return {
            "title": title,
            "content_html": content_html,
            "next_url": next_url,
            "prev_url": prev_url,
            "url": url
        }

class GenericParser(SiteParser):
    def parse(self, html: str, url: str) -> Dict[str, str]:
        soup = BeautifulSoup(html, 'lxml')
        
        # Try to find the biggest container with paragraphs
        paragraphs = soup.find_all('p')
        if not paragraphs:
            return {"title": "Unknown", "content_html": "<p>No text found.</p>", "next_url": None, "prev_url": None, "url": url}
            
        # Very rough heuristic: group p tags by their parent
        parent_counts = {}
        for p in paragraphs:
            parent = p.parent
            parent_counts[parent] = parent_counts.get(parent, 0) + len(p.text)
            
        best_parent = max(parent_counts, key=parent_counts.get)
        content_html = str(best_parent)
        
        # Guess title
        title_tag = soup.find(['h1', 'h2'], string=re.compile(r'chapter', re.I))
        if not title_tag:
            title_tag = soup.find('h1')
        title = title_tag.text.strip() if title_tag else "Unknown Chapter"
        
        # Guess next
        next_btn = soup.find('a', string=re.compile(r'next|Next|NEXT|>'))
        next_url = next_btn['href'] if next_btn and next_btn.has_attr('href') else None
        
        prev_btn = soup.find('a', string=re.compile(r'prev|Prev|PREV|<'))
        prev_url = prev_btn['href'] if prev_btn and prev_btn.has_attr('href') else None
        
        return {
            "title": title,
            "content_html": content_html,
            "next_url": next_url,
            "prev_url": prev_url,
            "url": url
        }

def scrape_url(url: str) -> Dict[str, str]:
    try:
        scraper = cloudscraper.create_scraper(browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        })
        response = scraper.get(url, timeout=15)
        response.raise_for_status()
        html = response.text
    except Exception as e:
        return {"error": str(e), "url": url}
        
    if "novelbin" in url:
        parser = NovelBinParser()
    else:
        parser = GenericParser()
        
    data = parser.parse(html, url)
    
    if data.get("redirect"):
        redirect_url = data["redirect"]
        if not redirect_url.startswith('http'):
            redirect_url = urljoin(url, redirect_url)
        return scrape_url(redirect_url)
    
    if data.get("next_url") and not data["next_url"].startswith('http'):
        data["next_url"] = urljoin(url, data["next_url"])
    if data.get("prev_url") and not data["prev_url"].startswith('http'):
        data["prev_url"] = urljoin(url, data["prev_url"])
        
    return data
