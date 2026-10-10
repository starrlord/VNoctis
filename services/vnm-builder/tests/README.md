Run the builder compatibility checks inside the builder container:

```sh
python -m unittest discover -s tests -v
```

The web builder preserves the legacy `images/` asset lookup fallback when the
imported game's bundled `renpy/config.py` declares `["", "images/"]`. Detection
reads a literal assignment without executing the imported module. Missing,
modern, custom, or dynamic engine defaults are left unchanged.

An early init script in the temporary build overlay restores that default when
the build engine starts with `[""]`. Game init settings can override it. Both
compressed and uncompressed builds use an overlay, including compression failure
fallbacks. Existing web builds need rebuilding to receive the fix. This does not
convert save formats or address other engine compatibility differences.
