import litellm
import spacy
from rapidfuzz import process, fuzz
import language_tool_python
from bs4 import BeautifulSoup

# Load small english model for basic NER
try:
    nlp = spacy.load("en_core_web_sm")
except:
    import subprocess
    import sys
    subprocess.run([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])
    nlp = spacy.load("en_core_web_sm")

try:
    tool = language_tool_python.LanguageTool('en-US')
except Exception as e:
    tool = None
    print(f"Failed to load LanguageTool: {e}")

# Sample DB, in reality load from request or DB file
character_db = {
    "John Doe": ["Jon Doe", "John", "John Do", "Jhon Doe"],
    "Alice": ["Alic", "Alise", "Alica"]
}

def correct_character_names(text: str, char_db: dict) -> str:
    if not char_db:
        return text
    
    all_known_names = []
    for correct_name, aliases in char_db.items():
        all_known_names.append(correct_name)
        all_known_names.extend(aliases)
        
    doc = nlp(text)
    replacements = []
    for ent in doc.ents:
        if ent.label_ == "PERSON":
            match = process.extractOne(ent.text, all_known_names, scorer=fuzz.ratio)
            if match and match[1] > 85: # threshold
                matched_name = match[0]
                true_name = matched_name
                for c_name, aliases in char_db.items():
                    if matched_name == c_name or matched_name in aliases:
                        true_name = c_name
                        break
                if true_name != ent.text:
                    replacements.append((ent.start_char, ent.end_char, true_name))
                    
    # Apply replacements from back to front
    for start, end, new_name in sorted(replacements, key=lambda x: x[0], reverse=True):
        text = text[:start] + new_name + text[end:]
        
    return text

def grammar_check(text: str) -> str:
    if not tool:
        return text
    matches = tool.check(text)
    text = language_tool_python.utils.correct(text, matches)
    return text

def llm_proofread(text: str, api_key: str, model_name: str, base_url: str = None) -> str:
    if not api_key or not model_name:
        return text
    
    kwargs = {
        "model": model_name,
        "messages": [{"role": "user", "content": f"Please proofread and fix glaring translation errors, weird phrasing, or inconsistencies in this text. Output the corrected text exactly as it was formatted, keeping each sentence on a distinct new line:\n{text}"}],
        "api_key": api_key,
    }
    if base_url:
        kwargs["api_base"] = base_url
        
    try:
        response = litellm.completion(**kwargs)
        result = response.choices[0].message.content.strip()
        if result:
            return result
    except Exception as e:
        print(f"LLM Fallback error: {e}")
    return text

import concurrent.futures

def process_chapter_html(html: str, char_db: dict, enable_grammar: bool = False, llm_config: dict = None):
    soup = BeautifulSoup(html, 'lxml')
    
    # Sanitize HTML (remove scripts and dangerous tags)
    for tag in soup(["script", "style", "iframe", "object", "embed"]):
        tag.decompose()
        
    try:
        sentences_per_chunk = int(llm_config.get('sentences_per_chunk', 5)) if llm_config else 5
    except (ValueError, TypeError):
        sentences_per_chunk = 5
        
    # Extract raw text with spaces, then tokenize into sentences
    text_content = soup.get_text(separator=' ')
    doc = nlp(text_content)
    all_sentences = [sent.text.strip() for sent in doc.sents if len(sent.text.strip()) > 2]
    
    chunks = []
    for i in range(0, len(all_sentences), sentences_per_chunk):
        chunk_sents = all_sentences[i:i+sentences_per_chunk]
        # Join them with double newlines so the LLM sees them distinctly
        chunks.append("\n\n".join(chunk_sents))
        
    total_chunks = len(chunks)
    
    if total_chunks == 0:
        yield str(soup)
        return
        
    def _process_single(i, original_text):
        text = correct_character_names(original_text, char_db)
        if enable_grammar:
            text = grammar_check(text)
        if llm_config and llm_config.get('enabled') and llm_config.get('api_key'):
            text = llm_proofread(
                text, 
                api_key=llm_config['api_key'], 
                model_name=llm_config.get('model', 'openai/gpt-3.5-turbo'),
                base_url=llm_config.get('base_url')
            )
        return i, text
        
    results = [None] * total_chunks
    
    # Process chunks
    if enable_grammar or (llm_config and llm_config.get('enabled')):
        max_workers = 10 
        yield {"status": f"NLP/LLM processing {total_chunks} chunks in parallel...", "progress": 40}
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = []
            for i, chunk_text in enumerate(chunks):
                futures.append(executor.submit(_process_single, i, chunk_text))
                    
            completed = 0
            for future in concurrent.futures.as_completed(futures):
                idx, text = future.result()
                results[idx] = text
                completed += 1
                yield {"status": f"Processed Chunk ({completed}/{total_chunks})...", "progress": 40 + int((completed/total_chunks)*50)}
    else:
        for i, chunk_text in enumerate(chunks):
            yield {"status": f"Character Correction ({i+1}/{total_chunks})...", "progress": 40 + int((i/total_chunks)*50)}
            results[i] = correct_character_names(chunk_text, char_db)
            
    # Rebuild HTML with distinct lines
    final_html_parts = []
    for chunk in results:
        if not chunk: continue
        for line in chunk.split('\n'):
            line = line.strip()
            if line:
                final_html_parts.append(f"<p>{line}</p>")
                
    yield f"<div class='chapter-content'>{''.join(final_html_parts)}</div>"
