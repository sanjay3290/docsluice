$.survey.name: Estuary monitoring

$.survey.season: 2026

$.survey.lead: Ada Field

$.survey.sites[0].id: north-inlet

$.survey.sites[0].depth_m: 3.5

$.survey.sites[0].tags: [mud, reeds]

$.survey.sites[1].id: south-bank

$.survey.sites[1].depth_m: 1.2

$.survey.defaults.units: metric

$.survey.defaults.repeat: 3

$.survey.overrides\["<<"\]: *defaults

$.survey.overrides.repeat: 5

$.notes: Sampling starts at low tide.
Bring spare batteries.

$.summary: Folded text keeps one paragraph.

$\["odd key"\]: value with: colon

```yaml
%YAML 1.2
# Field survey configuration (synthetic)
---
survey:
  name: Estuary monitoring
  season: 2026
  lead: "Ada Field"   # quoted value with a comment
  sites:
    - id: north-inlet
      depth_m: 3.5
      tags: [mud, reeds]
    - id: south-bank
      depth_m: 1.2
  defaults: &defaults
    units: metric
    repeat: 3
  overrides:
    <<: *defaults
    repeat: 5
notes: |
  Sampling starts at low tide.
  Bring spare batteries.
summary: >
  Folded text keeps
  one paragraph.
"odd key": value with: colon
empty:
...

```