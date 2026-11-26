"""Shared category vocabulary, including supported historical producer values."""
CATEGORY_MEANINGS = {
    'stable_profile':'durable profile', 'persona':'role persona', 'event':'event',
    'fact':'fact', 'notes':'notes', 'private':'private scene', 'episode':'episode',
    'tool':'tool knowledge', 'about_him':'about owner', 'misc':'miscellaneous',
    'commitment':'commitment', 'date':'date', 'speech':'speech', 'manual':'manual',
    'procedure':'promoted tool procedure',
    'skill':'legacy lesson category; record type controls eligibility',
    'reflect':'legacy reflection category; record type controls eligibility',
    'content_unavailable':'legacy unavailable-content marker; not usable evidence',
}
KNOWN_CATEGORIES = frozenset(CATEGORY_MEANINGS)
