"""Controlled vocabulary for zero-shot frame labels.

MUST stay identical to `worker/src/marketing/cv/vocab.ts` (contract §6). The
facets are the same eight facets as the TS twin; only a subset of them is
zero-shot-labelled here (see ZERO_SHOT_FACETS) because `motion`, `purpose` and
`reproducibility` are not visible in a single still frame — the LLM shot
analyzer owns those.

Label rule (documented in README §"Zero-shot labels"): for every facet in
ZERO_SHOT_FACETS the frame embedding is scored against every label's prompt
embedding with SigLIP's own logit scale + bias; a softmax over the facet's
labels gives per-label probabilities; the top-2 labels whose probability is
>= LABEL_MIN_PROB are emitted as `facet:label`.
"""

from __future__ import annotations

VOCAB: dict[str, list[str]] = {
    "shot_size": ["wide", "medium", "close", "extreme_close", "aerial"],
    "setting": [
        "exterior_facade", "interior_living", "kitchen", "bedroom", "bathroom",
        "amenity_pool", "gym", "lobby", "street", "map", "studio", "render", "office",
    ],
    "subject": ["building", "unit", "person", "presenter", "family", "vehicle", "text_card", "logo", "map", "plan"],
    "graphic": ["none", "text_overlay", "animated_map", "3d_render", "motion_graphic", "split_screen", "slideshow"],
    "motion": ["static", "pan", "tilt", "dolly", "drone", "handheld", "zoom"],
    "light": ["day", "golden", "night", "studio"],
    "purpose": ["hook", "location", "product", "feature", "proof", "offer", "cta", "brand"],
    "reproducibility": ["easy", "moderate", "hard"],
}

# Facets that can be judged from one still frame.
ZERO_SHOT_FACETS: tuple[str, ...] = ("shot_size", "setting", "subject", "graphic", "light")

# Minimum softmax probability (within the facet) for a label to be emitted; at
# most 2 labels per facet.
LABEL_MIN_PROB = 0.2
LABEL_TOP_K = 2

# Natural-language prompts per label ("a photo of ..." style — SigLIP was
# trained on captions, so short descriptive phrases work best).
PROMPTS: dict[str, dict[str, str]] = {
    "shot_size": {
        "wide": "a wide shot showing a whole building or a large space",
        "medium": "a medium shot of a room or a person from the waist up",
        "close": "a close-up shot of an object, a face or a detail",
        "extreme_close": "an extreme close-up macro shot of a texture or a small detail",
        "aerial": "an aerial drone shot from high above a city or a building",
    },
    "setting": {
        "exterior_facade": "a photo of the exterior facade of a residential building",
        "interior_living": "a photo of a living room interior with sofas",
        "kitchen": "a photo of a kitchen with cabinets and countertops",
        "bedroom": "a photo of a bedroom with a bed",
        "bathroom": "a photo of a bathroom with a sink, shower or bathtub",
        "amenity_pool": "a photo of a swimming pool at a residential compound",
        "gym": "a photo of a gym with fitness equipment",
        "lobby": "a photo of a building lobby or entrance hall",
        "street": "a photo of a street or a road with cars and buildings",
        "map": "a map showing locations, roads and landmarks",
        "studio": "a person speaking in a studio with a plain background",
        "render": "a 3D architectural rendering of a building or an apartment",
        "office": "a photo of an office interior with desks",
    },
    "subject": {
        "building": "a photo of a building",
        "unit": "a photo of an apartment or villa interior",
        "person": "a photo of a person",
        "presenter": "a person presenting and talking to the camera",
        "family": "a photo of a family with children",
        "vehicle": "a photo of a car or a vehicle",
        "text_card": "a title card with large text on a plain background",
        "logo": "a company logo on a plain background",
        "map": "a map",
        "plan": "an architectural floor plan drawing",
    },
    "graphic": {
        "none": "a real photograph with no graphics or text",
        "text_overlay": "a photo with text overlaid on top of it",
        "animated_map": "an animated map graphic with highlighted routes and pins",
        "3d_render": "a computer-generated 3D rendering",
        "motion_graphic": "a flat motion graphic animation with shapes and icons",
        "split_screen": "a split screen showing two images side by side",
        "slideshow": "a slideshow of photos with a frame or border",
    },
    "light": {
        "day": "a photo taken in bright daylight",
        "golden": "a photo taken at sunset or sunrise with warm golden light",
        "night": "a photo taken at night with artificial lights",
        "studio": "a photo taken with even studio lighting on a plain background",
    },
}


def prompt_pairs() -> list[tuple[str, str, str]]:
    """Flat list of (facet, label, prompt) for the zero-shot facets, in a stable order."""
    out: list[tuple[str, str, str]] = []
    for facet in ZERO_SHOT_FACETS:
        for label in VOCAB[facet]:
            out.append((facet, label, PROMPTS[facet][label]))
    return out
