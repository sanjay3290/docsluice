"""Original deterministic MS-OFFCRYPTO fixtures; cryptography is test-tool only.

No document contents or third-party implementation are copied. Password is public
test data. Python hashlib/hmac and cryptography independently produce ciphertext.
Specification: MS-OFFCRYPTO 2.3.4.7 and 2.3.4.11-15; MS-CFB container layout.
"""
import base64
import hashlib
import hmac
import io
import json
import pathlib
import struct
import zipfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ROOT = pathlib.Path(__file__).parent
PASSWORD = 'Public test \u00e9\U0001f600'
FREE, END, FAT = 0xffffffff, 0xfffffffe, 0xfffffffd
BLOCKS = [bytes.fromhex(x) for x in ['fea7d2763b4b9e79', 'd7aa0f6d3061344e', '146e0be7abacd0d6', '5fb2ad010cb9e1f6', 'a0677f02b22c8433']]

def b64(value):
    return base64.b64encode(value).decode()

def pad(value, size=16, byte=0):
    return value + bytes([byte]) * ((-len(value)) % size)

def resize(value, size, byte=0x36):
    return (value + bytes([byte]) * size)[:size]

def aes(value, key, iv=None):
    mode = modes.ECB() if iv is None else modes.CBC(iv)
    enc = Cipher(algorithms.AES(key), mode).encryptor()
    return enc.update(pad(value)) + enc.finalize()

def spun(salt, algorithm, spins):
    digest = lambda value: hashlib.new(algorithm, value).digest()
    result = digest(salt + PASSWORD.encode('utf-16le'))
    for index in range(spins):
        result = digest(struct.pack('<I', index) + result)
    return result

def standard(plain, bits):
    salt = bytes(range(16))
    verifier = bytes(range(32, 48))
    final = hashlib.sha1(spun(salt, 'sha1', 50000) + bytes(4)).digest()
    parts = []
    for fill in (0x36, 0x5c):
        buf = bytearray([fill] * 64)
        for index, value in enumerate(final):
            buf[index] ^= value
        parts.append(hashlib.sha1(buf).digest())
    key = b''.join(parts)[:bits // 8]
    header = struct.pack('<8I', 0x24, 0, {128:0x660e, 192:0x660f, 256:0x6610}[bits], 0x8004, bits, 0x18, 0, 0)
    info = struct.pack('<HHII', 4, 2, 0x24, len(header)) + header
    info += struct.pack('<I', 16) + salt + aes(verifier, key) + struct.pack('<I', 20) + aes(hashlib.sha1(verifier).digest(), key)
    return info, struct.pack('<Q', len(plain)) + aes(plain, key)

def agile(plain, algorithm, bits, password_bits, salt_size=16):
    digest = lambda value: hashlib.new(algorithm, value).digest()
    hash_size = len(digest(b''))
    salt = bytes((index + 64) % 256 for index in range(salt_size))
    password_salt = bytes((index + 3) % 256 for index in range(salt_size))
    verifier = bytes((index + 111) % 256 for index in range(salt_size))
    intermediate = bytes(range(bits // 8))
    value = spun(password_salt, algorithm, 8)
    wrapping = [resize(digest(value + block), password_bits // 8) for block in BLOCKS[:3]]
    password_iv = resize(password_salt, 16)
    encrypted_verifier = aes(verifier, wrapping[0], password_iv)
    encrypted_hash = aes(digest(verifier), wrapping[1], password_iv)
    encrypted_key = aes(intermediate, wrapping[2], password_iv)
    package = struct.pack('<Q', len(plain))
    for index, offset in enumerate(range(0, len(plain), 4096)):
        package += aes(plain[offset:offset+4096], intermediate, resize(digest(salt + struct.pack('<I', index)), 16))
    hmac_key = bytes((index + 153) % 256 for index in range(salt_size))
    hmac_value = hmac.new(hmac_key, package, algorithm).digest()
    hkey = aes(hmac_key, intermediate, resize(digest(salt + BLOCKS[3]), 16))
    hvalue = aes(hmac_value, intermediate, resize(digest(salt + BLOCKS[4]), 16))
    spec_hash = {'sha1':'SHA-1','sha256':'SHA256','sha384':'SHA384','sha512':'SHA512'}[algorithm]
    common = f'saltSize="{salt_size}" blockSize="16" hashSize="{hash_size}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="{spec_hash}"'
    xml = f'<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"><keyData {common} keyBits="{bits}" saltValue="{b64(salt)}"/><dataIntegrity encryptedHmacKey="{b64(hkey)}" encryptedHmacValue="{b64(hvalue)}"/><keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password"><p:encryptedKey xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" {common} keyBits="{password_bits}" saltValue="{b64(password_salt)}" spinCount="8" encryptedVerifierHashInput="{b64(encrypted_verifier)}" encryptedVerifierHashValue="{b64(encrypted_hash)}" encryptedKeyValue="{b64(encrypted_key)}"/></keyEncryptor></keyEncryptors></encryption>'
    return struct.pack('<HHI', 4, 4, 0x40) + xml.encode(), package

def cfb(info, package):
    # Two root streams; short streams use a shared mini stream, long streams FAT.
    mini = bytearray()
    mini_fat = [FREE] * 128
    data = [bytearray(512), bytearray(512), bytearray(512)]
    fat = [FREE] * 128
    fat[0], fat[1], fat[2] = FAT, END, END
    def chain(value):
        start = len(data)
        for off in range(0, len(value), 512):
            sid = len(data)
            data.append(bytearray(value[off:off+512].ljust(512, b'\0')))
            fat[sid] = sid + 1 if off + 512 < len(value) else END
        return start if value else END
    streams = []
    for name, value in [('EncryptionInfo', info), ('EncryptedPackage', package)]:
        if len(value) < 4096:
            start = len(mini) // 64
            rounded = pad(value, 64)
            mini.extend(rounded)
            count = len(rounded) // 64
            for index in range(start, start + count):
                mini_fat[index] = index + 1 if index + 1 < start + count else END
        else:
            start = chain(value)
        streams.append((name, start, len(value)))
    root_start = chain(mini)
    directory = data[1]
    def entry(index, name, kind, start, size, child=FREE, right=FREE):
        off = index * 128
        encoded = (name + '\0').encode('utf-16le')
        directory[off:off+len(encoded)] = encoded
        struct.pack_into('<HBBIII', directory, off+64, len(encoded), kind, 1, FREE, right, child)
        struct.pack_into('<IQ', directory, off+116, start, size)
    entry(0, 'Root Entry', 5, root_start, len(mini), child=1)
    for index, (name, start, size) in enumerate(streams, 1):
        entry(index, name, 2, start, size, right=2 if index == 1 else FREE)
    data[0][:] = struct.pack('<128I', *fat)
    data[2][:] = struct.pack('<128I', *mini_fat)
    header = bytearray(512)
    header[:8] = bytes.fromhex('d0cf11e0a1b11ae1')
    struct.pack_into('<5H', header, 24, 0x3e, 3, 0xfffe, 9, 6)
    struct.pack_into('<9I', header, 40, 0, 1, 1, 0, 4096, 2, 1, END, 0)
    struct.pack_into('<109I', header, 76, 0, *([FREE] * 108))
    return bytes(header) + b''.join(data)

def package(format):
    stream = io.BytesIO()
    paths = {'docx':'word/document.xml', 'xlsx':'xl/workbook.xml', 'pptx':'ppt/presentation.xml'}
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, text in [('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), (paths[format], '<original>Public fixture</original>')]:
            item = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            item.external_attr = 0o100644 << 16
            archive.writestr(item, text)
    # Exercise exact length trimming and 4096-byte segment boundaries.
    return stream.getvalue().ljust(8193, b'\xa5')

def main():
    cases = []
    for bits in (128, 192, 256):
        plain = package('docx')
        info, encrypted = standard(plain, bits)
        cases.append((f'standard-{bits}', plain, info, encrypted))
    for algorithm, bits, wrapping_bits, salt_size, format in [('sha1',128,256,16,'docx'), ('sha256',192,128,17,'xlsx'), ('sha384',256,192,16,'pptx'), ('sha512',256,256,16,'docx')]:
        plain = package(format)
        info, encrypted = agile(plain, algorithm, bits, wrapping_bits, salt_size)
        cases.append((f'agile-{algorithm}-{bits}', plain, info, encrypted))
    for size in (0, 16, 4096, 4097):
        plain = bytes((index % 256 for index in range(size)))
        info, encrypted = agile(plain, 'sha512', 128, 192)
        cases.append((f'agile-boundary-{size}', plain, info, encrypted))
    manifest = []
    for name, plain, info, encrypted in cases:
        filename = name + '.cfb'
        container = cfb(info, encrypted)
        (ROOT / filename).write_bytes(container)
        (ROOT / (filename + '.license')).write_text('Original synthetic fixture generated for docsluice; MIT license. Public test data only.\n')
        manifest.append({'name':name, 'file':filename, 'password':PASSWORD, 'plaintext':b64(plain), 'info':b64(info), 'package':b64(encrypted), 'sha256':hashlib.sha256(container).hexdigest()})
    (ROOT / 'cases.json').write_text(json.dumps(manifest, indent=2) + '\n')
    hostile = ROOT.parents[4] / 'hostile' / 'office'
    hostile.mkdir(exist_ok=True)
    source = next(case for case in cases if case[0] == 'agile-sha512-256')
    bad_info = source[2].replace(b'spinCount="8"', b'spinCount="10000001"')
    changed = bytearray(source[3])
    changed[100] ^= 1
    for name, info, encrypted in [('spin-count-overflow.cfb', bad_info, source[3]), ('hmac-tampered.cfb', source[2], changed)]:
        (hostile / name).write_bytes(cfb(info, encrypted))
        (hostile / (name + '.license')).write_text('Original synthetic hostile fixture generated for docsluice; MIT license. Public test data only.\n')
    print(json.dumps({'cases':len(cases), 'hashes':{x['file']:x['sha256'] for x in manifest}}))

if __name__ == '__main__':
    main()
