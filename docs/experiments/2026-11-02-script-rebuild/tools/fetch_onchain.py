import hashlib, json, os, subprocess, sys

RPC = {"mainnet": "https://mainnet.ckb.dev/", "testnet": "https://testnet.ckb.dev/"}
HT = {"data": 0, "type": 1, "data1": 2, "data2": 4}

def rpc(net, method, params):
    body = json.dumps({"id": 1, "jsonrpc": "2.0", "method": method, "params": params})
    raw = subprocess.run(["curl", "-sS", "-m", "60", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", RPC[net]],
                         input=body.encode(), capture_output=True, check=True).stdout
    out = json.loads(raw)
    if out.get("error"):
        raise RuntimeError(out["error"])
    return out["result"]

def ckbhash(b):
    return "0x" + hashlib.blake2b(b, digest_size=32, person=b"ckb-default-hash").hexdigest()

def script_bytes(s):
    code = bytes.fromhex(s["code_hash"][2:]); ht = bytes([HT[s["hash_type"]]]); args = bytes.fromhex(s["args"][2:])
    argsb = len(args).to_bytes(4, "little") + args
    total = 16 + 32 + 1 + len(argsb)
    return total.to_bytes(4, "little") + (16).to_bytes(4, "little") + (48).to_bytes(4, "little") + (49).to_bytes(4, "little") + code + ht + argsb

TARGETS = [
  ("nervos-dao", "mainnet", "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e", "type", "0xe2fb199810d49a4d8beec56718ba2593b665db9d52299a0f9e6e75416d73ff5c", 2),
  ("xudt", "mainnet", "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95", "data1", "0xc07844ce21b38e4b071dd0e1ee3b0e27afd8d7532491327f39b786343f558ab7", 0),
  ("omnilock", "mainnet", "0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26", "type", "0xc76edf469816aa22f416503c38d0b533d2a018e253e379f134c3985b3472c842", 0),
  ("spore", "mainnet", "0x4a4dce1df3dffff7f8b2cd7dff7303df3b6150c9788cb75dcf6747247132b9f5", "data1", "0x96b198fb5ddbd1eed57ed667068f1f1e55d07907b4c0dbd38675a69ea1b69824", 0),
  ("ckb-js-vm", "testnet", "0x3e9b6bead927bef62fcb56f0c79f4fbd1b739f32dd222beac10d346f2918bed7", "type", "0xf594e7deb3bdec611b20bdf7814acf7779ddf061a8f207b1f3261242b8dc4494", 0),
]

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)
results = []
for name, net, code_hash, ht, txh, idx in TARGETS:
    r = {"name": name, "network": net, "documented": {"code_hash": code_hash, "hash_type": ht, "tx_hash": txh, "index": idx}}
    tx = rpc(net, "get_transaction", [txh])
    r["documented_tx_block_hash"] = tx["tx_status"]["block_hash"]
    out = tx["transaction"]["outputs"][idx]
    data = bytes.fromhex(tx["transaction"]["outputs_data"][idx][2:])
    r["documented_cell"] = {"size": len(data), "data_hash": ckbhash(data), "sha256": hashlib.sha256(data).hexdigest(), "type": out.get("type")}
    open(os.path.join(outdir, f"{name}.documented.bin"), "wb").write(data)
    live = rpc(net, "get_live_cell", [{"tx_hash": txh, "index": hex(idx)}, False])
    r["documented_cell_status"] = live["status"]
    if ht in ("data1", "data", "data2"):
        r["code_hash_matches_documented_cell"] = (r["documented_cell"]["data_hash"] == code_hash)
    else:
        t = out.get("type")
        r["type_script_hash"] = ckbhash(script_bytes(t)) if t else None
        r["code_hash_matches_documented_cell"] = (r["type_script_hash"] == code_hash)
        cells = rpc(net, "get_cells", [{"script": t, "script_type": "type", "script_search_mode": "exact"}, "asc", "0x10"]) if t else None
        cur = []
        for c in (cells or {}).get("objects", []):
            otx = rpc(net, "get_transaction", [c["out_point"]["tx_hash"]])
            i = int(c["out_point"]["index"], 16)
            d = bytes.fromhex(otx["transaction"]["outputs_data"][i][2:])
            name_cur = f"{name}.current.{c['out_point']['tx_hash'][2:10]}-{i}.bin"
            open(os.path.join(outdir, name_cur), "wb").write(d)
            cur.append({"out_point": c["out_point"], "block_number": int(c["block_number"], 16), "block_hash": otx["tx_status"]["block_hash"],
                        "size": len(d), "data_hash": ckbhash(d), "sha256": hashlib.sha256(d).hexdigest(), "file": name_cur})
        r["current_live_cells_with_type"] = cur
    tip = rpc(net, "get_tip_header", [])
    r["read_at_tip"] = {"number": int(tip["number"], 16), "hash": tip["hash"]}
    results.append(r)
json.dump(results, open(os.path.join(outdir, "onchain.json"), "w"), indent=2)
print(json.dumps(results, indent=2))
