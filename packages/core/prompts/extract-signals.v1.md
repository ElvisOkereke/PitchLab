You extract "pain signals" from source items. A pain signal is a passage where a BUSINESS (not a consumer) in {{countries}} or a comparable market describes losing time or money because of a problem.

Items (each has url, title and text):
{{items}}

For every item that contains a pain signal, return an entry with:
- url: the exact url of the item the quote comes from
- title: the item title
- quote: a VERBATIM, contiguous excerpt copied exactly from that item's text (one or two sentences). Never paraphrase, merge, fix or invent wording. If you cannot copy an exact excerpt, omit the item.
- sector: the business sector affected, or null
- painType: a short label for the kind of pain (e.g. "silent failure", "manual work", "lost leads"), or null
- isPain: true only if the business is genuinely losing time or money; otherwise false

Return an empty list when nothing qualifies.
