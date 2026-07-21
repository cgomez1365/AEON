import sys
import urllib.request
import urllib.parse
from bs4 import BeautifulSoup

def run_search(query):
    try:
        # Format the DuckDuckGo HTML search URL
        search_url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        
        # Build request with a standard User-Agent header to avoid basic blocking
        req = urllib.request.Request(
            search_url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        
        # Fetch the HTML search results page
        html_content = urllib.request.urlopen(req, timeout=10).read()
        
        # Parse search results
        soup = BeautifulSoup(html_content, 'html.parser')
        results = []
        
        for r in soup.find_all('div', class_='result'):
            title_a = r.find('a', class_='result__a')
            snippet_a = r.find('a', class_='result__snippet')
            url_a = r.find('a', class_='result__url')
            
            if title_a and url_a:
                title = title_a.text.strip()
                snippet = snippet_a.text.strip() if snippet_a else "No description available."
                raw_href = url_a['href']
                
                # Extract and decode the true target URL from DuckDuckGo redirect
                if 'uddg=' in raw_href:
                    decoded_url = urllib.parse.unquote(raw_href.split('uddg=')[1].split('&')[0])
                else:
                    decoded_url = raw_href
                    
                results.append({
                    "title": title,
                    "body": snippet,
                    "href": decoded_url
                })
        
        if not results:
            return f"**Atlas Intelligence:** No immediate search results found on the web for `{query}`."

        # Format the output report for the CEO
        report = f"### 🌐 ATLAS RESEARCH DOSSIER\n**Topic:** `{query}`\n\n---\n\n"
        for i, res in enumerate(results[:5]):  # Output top 5 results
            report += f"#### {i+1}. {res['title']}\n"
            report += f"> {res['body']}\n\n"
            report += f"🔗 **Source:** [{res['href']}]({res['href']})\n\n"
            report += "---\n\n"
        
        return report.strip()
    except Exception as e:
        return f"**Atlas Intelligence Error:** Failed to execute web research. Detail: {str(e)}"

if __name__ == "__main__":
    # Ensure UTF-8 output encoding for Windows command line compatibility
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else ""
    if query:
        print(run_search(query))
    else:
        print("**Atlas Intelligence Error:** No query provided.")
