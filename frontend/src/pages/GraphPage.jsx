import React, { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import GraphCanvas from '../components/GraphCanvas';
import GraphControls from '../components/GraphControls';
import DocumentDrawer from '../components/DocumentDrawer';
import { getGraphData } from '../lib/api';

export default function GraphPage({ theme = 'dark', setTheme }) {
  const { notebookId } = useParams();
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [minSimilarity, setMinSimilarity] = useState(0.3);
  const [repulsion, setRepulsion] = useState(200);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    getGraphData(minSimilarity, notebookId)
      .then(({ data }) => {
        if (isMounted) {
          setNodes(data.nodes || []);
          setEdges(data.edges || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load graph data:', err);
        if (isMounted) setLoading(false);
      });
    return () => { isMounted = false; };
  }, [minSimilarity, notebookId]);

  const handleReset = () => {
    setMinSimilarity(0.3);
    setRepulsion(200);
    setSearchQuery('');
  };

  return (
    <div className="w-full h-screen bg-carbon text-text overflow-hidden flex flex-col">
      {/* Top Header Bar */}
      <header className="h-14 flex-shrink-0 flex items-center justify-between px-6 bg-surface border-b border-border z-10 shadow-sm">
        {/* Left Side: Back Button & Page Title */}
        <div className="flex items-center gap-4">
          <Link
            to={notebookId ? `/app/${notebookId}` : '/app'}
            className="px-3 py-1.5 bg-surface-2 hover:bg-surface border border-border rounded-lg text-xs text-text hover:text-accent transition-colors flex items-center gap-2 font-medium"
          >
            <ArrowLeft className="w-4 h-4 text-accent" />
            <span>{notebookId ? 'Back to Notebook' : 'Notebooks'}</span>
          </Link>

          <div className="h-4 w-px bg-border" />

          <h1 className="font-serif text-lg font-medium text-text flex items-center gap-2">
            doc<span className="text-accent">Seek</span> Knowledge Graph
          </h1>
        </div>

        {/* Right Side: Graph Controls & Filters */}
        <GraphControls
          minSimilarity={minSimilarity}
          setMinSimilarity={setMinSimilarity}
          repulsion={repulsion}
          setRepulsion={setRepulsion}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onReset={handleReset}
          theme={theme}
          setTheme={setTheme}
        />
      </header>

      {/* Main Canvas Area */}
      <main className="flex-1 w-full h-[calc(100vh-56px)] relative overflow-hidden flex flex-col bg-carbon">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-text-dim text-xs gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span>Building knowledge graph...</span>
          </div>
        ) : (
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            repulsion={repulsion}
            searchQuery={searchQuery}
            onSelectNode={setSelectedNode}
            theme={theme}
          />
        )}

        <DocumentDrawer
          node={selectedNode}
          edges={edges}
          onClose={() => setSelectedNode(null)}
        />
      </main>
    </div>
  );
}

