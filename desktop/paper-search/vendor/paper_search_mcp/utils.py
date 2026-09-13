import re

def extract_doi(text: str) -> str:
    """Accept a DOI/DOI URL only; incidental abstract citations are not paper identity."""
    if not text:
        return ""
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text.strip(), flags=re.IGNORECASE)
    match = re.fullmatch(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", text, re.IGNORECASE)
    return match.group(0).rstrip(".,;)") if match else ""
