"""Pure in-memory algorithms ported from Lectio into a strict acyclic DAG.

Modules in this package never import FastAPI, SQLAlchemy models, or disk/network
configuration stores. Higher-level services supply page data, storage, and LLM clients.
"""
