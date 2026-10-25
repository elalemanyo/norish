from __future__ import annotations

import json
import unittest

from app.main import ParseRequest, parse_recipe


class ParserJsonLdTests(unittest.TestCase):
    def test_reads_the_recipe_beside_an_empty_json_ld_tag(self) -> None:
        # Food Network UK ships empty JSON-LD tags next to its Recipe.
        recipe = {"@context": "https://schema.org", "@type": "Recipe", "name": "Perfect Roast Chicken"}
        html = (
            '<html><head><script type="application/ld+json"></script>'
            f'<script type="application/ld+json">{json.dumps(recipe)}</script>'
            "</head><body></body></html>"
        )

        response = parse_recipe(
            ParseRequest(url="https://foodnetwork.co.uk/recipes/perfect-roast-chicken", html=html)
        )

        assert response.ok, response
        self.assertEqual(response.recipe["title"], "Perfect Roast Chicken")


if __name__ == "__main__":
    unittest.main()
