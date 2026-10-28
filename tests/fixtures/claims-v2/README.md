# Synthetic claims-v2 fixtures

`synthetic.ts` constructs inert manifest, transaction, RPC and alias-map inputs for
unit tests. None is a captured chain response, signed acceptance fixture, native
execution result or deployment identity. The fake runner writes these inputs via
its injected adapter; no producer command, devnet or native tool is executed.

Real DAO, secp regression and separate Spore feasibility gates remain pending.
