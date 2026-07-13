"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";

export default function ApiKeyModelMultiSelectField({ value, onChange, disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const loadOptions = async () => {
      const [providersResult, aliasesResult] = await Promise.allSettled([
        fetch("/api/providers").then((response) => response.ok ? response.json() : { connections: [] }),
        fetch("/api/models/alias").then((response) => response.ok ? response.json() : { aliases: {} }),
      ]);

      if (cancelled) return;
      if (providersResult.status === "fulfilled") {
        setActiveProviders((providersResult.value.connections || []).filter((connection) => connection.isActive !== false));
      }
      if (aliasesResult.status === "fulfilled") {
        setModelAliases(aliasesResult.value.aliases || {});
      }
    };

    loadOptions();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const addModel = (model) => {
    if (!model?.value || value.includes(model.value)) return;
    onChange([...value, model.value]);
  };

  const removeModel = (model) => {
    if (!model?.value) return;
    onChange(value.filter((selectedModel) => selectedModel !== model.value));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label className="text-sm font-medium text-text-main">Allowed models and combos</label>
          <p className="text-xs text-text-muted">Leave empty to allow all models.</p>
        </div>
        <Button type="button" size="sm" variant="secondary" icon="add" onClick={() => setIsOpen(true)} disabled={disabled}>
          Select
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-muted">All models</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" aria-label="Allowed models">
          {value.map((model) => (
            <span key={model} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
              <span className="truncate">{model}</span>
              <button
                type="button"
                aria-label={`Remove ${model}`}
                onClick={() => removeModel({ value: model })}
                disabled={disabled}
                className="inline-flex rounded hover:bg-primary/15 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </span>
          ))}
        </div>
      )}

      <ModelSelectModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSelect={addModel}
        onDeselect={removeModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={value}
        closeOnSelect={false}
        title="Select allowed models and combos"
      />
    </div>
  );
}

ApiKeyModelMultiSelectField.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
