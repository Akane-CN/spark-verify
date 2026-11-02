import hashlib, sys
for p in sys.argv[1:]:
    b = open(p, "rb").read()
    print("0x" + hashlib.blake2b(b, digest_size=32, person=b"ckb-default-hash").hexdigest(), hashlib.sha256(b).hexdigest(), len(b), p)
